"use client";

import { useMemo, useRef, useState } from "react";
import DeckGL from "@deck.gl/react";
import { FlyToInterpolator, type MapViewState, type PickingInfo } from "@deck.gl/core";
import {
  BitmapLayer,
  GeoJsonLayer,
  LineLayer,
  ScatterplotLayer,
  SolidPolygonLayer,
} from "@deck.gl/layers";
import { TileLayer } from "@deck.gl/geo-layers";
import { clampBBox } from "@/lib/lod";
import { aqiBand, fireColor, fireRadius } from "@/lib/aqi";
import { useStore } from "@/lib/store";

/**
 * Basemap as deck.gl raster TileLayers rather than a MapLibre GL instance.
 *
 * MapLibre initialised fine but never drew: deck.gl and MapLibre each create
 * their own WebGL context, and rendering both was not reliable. Putting the
 * basemap through the same pipeline as every other layer removes that whole
 * class of failure, drops two dependencies, and costs only the difference
 * between raster and vector tiles — which, under a dark data overlay, is not
 * a difference anyone sees.
 *
 * Esri rather than CARTO: CARTO's raster endpoint now stamps
 * "API KEY REQUIRED" across every tile. Esri's Light Gray Canvas serves without
 * a key and splits terrain from labels, so place names can sit under the data
 * instead of fighting it. Note ArcGIS orders the path {z}/{y}/{x}.
 */
const BASEMAP_TILES =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const BASEMAP_LABELS =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}";

/** NWS coverage stops here; everything else gets the "no coverage" mask. */
const CONUS: [number, number, number, number] = [-125, 24, -66.5, 49.5];

/** How long a PM2.5 reading stays on screen before the station goes hollow. */
const CARRY_HOURS = 3;

const INITIAL_VIEW: MapViewState = {
  longitude: -100,
  latitude: 44,
  zoom: 3.1,
  pitch: 0,
  bearing: 0,
};

/**
 * Camera that frames a bounding box. Approximated from the box's angular span
 * rather than measured against pixel dimensions — close enough to frame an
 * answer, and it avoids plumbing container size through just to pick a zoom.
 */
function cameraFor(bbox: [number, number, number, number]): MapViewState {
  const [w, s, e, n] = bbox;
  const lonSpan = Math.max(Math.abs(e - w), 0.05);
  const latSpan = Math.max(Math.abs(n - s), 0.05);
  const zoom = Math.min(Math.log2(360 / lonSpan), Math.log2(180 / latSpan)) - 0.45;
  return {
    longitude: (w + e) / 2,
    latitude: (s + n) / 2,
    zoom: Math.max(1.2, Math.min(10.5, zoom)),
    pitch: 0,
    bearing: 0,
  };
}

export default function MapView({
  onViewportChange,
}: {
  onViewportChange?: (bbox: [number, number, number, number]) => void;
}) {
  const data = useStore((s) => s.data);
  const cursorHour = useStore((s) => s.cursorHour);
  const layers = useStore((s) => s.layers);
  const focusStationId = useStore((s) => s.focusStationId);
  const setFocusStation = useStore((s) => s.setFocusStation);
  const flyToTarget = useStore((s) => s.flyToTarget);

  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW);
  const [appliedNonce, setAppliedNonce] = useState(0);
  const lastBBox = useRef<string>("");

  /**
   * Carry out a camera request from the store. This is what makes an answer
   * move the map — without it the agent is just a chat box beside a map.
   *
   * Adjusted during render rather than in an effect: the camera is derived from
   * a request that has already happened, so waiting for an effect would render
   * one frame at the old position first.
   */
  if (flyToTarget && flyToTarget.nonce !== appliedNonce) {
    setAppliedNonce(flyToTarget.nonce);
    setViewState({
      ...cameraFor(flyToTarget.bbox),
      transitionDuration: 900,
      transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
    } as MapViewState);
  }

  /**
   * Dense PM2.5 lookup, built ONCE when the payload lands.
   *
   * The payload is sparse triples; scanning them per frame would be O(n) at
   * 60fps. A station-major Float32Array makes the accessor an O(1) index, which
   * is what keeps scrubbing smooth with a couple of thousand stations.
   *
   * Values are carried FORWARD up to CARRY_HOURS, because stations report
   * hourly and arrive minutes late: requiring an exact hour match leaves most
   * of the map blank at any given instant (measured: 0% of stations had a value
   * at the newest hour, 64% one hour back). A reading from an hour ago is still
   * that station's current measurement, so this shows what is known rather than
   * inventing anything — nothing is ever carried BACKWARD to before a station
   * first reported, and `age` travels alongside so the UI can dim it and the
   * tooltip can name the real observation time.
   */
  const { pmGrid, pmAge } = useMemo(() => {
    if (!data) return { pmGrid: null, pmAge: null };
    const { hours } = data.meta;
    const n = data.stations.id.length;
    const grid = new Float32Array(n * hours).fill(NaN);
    for (let i = 0; i < data.pm25.station.length; i++) {
      grid[data.pm25.station[i] * hours + data.pm25.hour[i]] = data.pm25.value[i];
    }

    const age = new Uint8Array(n * hours).fill(255);
    for (let s = 0; s < n; s++) {
      const base = s * hours;
      let carried = NaN;
      let carriedAge = 0;
      for (let h = 0; h < hours; h++) {
        const v = grid[base + h];
        if (!Number.isNaN(v)) {
          carried = v;
          carriedAge = 0;
        } else if (!Number.isNaN(carried) && carriedAge < CARRY_HOURS) {
          carriedAge++;
          grid[base + h] = carried;
        } else {
          carried = NaN;
          continue;
        }
        age[base + h] = carriedAge;
      }
    }
    return { pmGrid: grid, pmAge: age };
  }, [data]);

  const stationPoints = useMemo(() => {
    if (!data) return [];
    return data.stations.id.map((id, i) => ({
      index: i,
      id,
      name: data.stations.name[i],
      position: [data.stations.lon[i], data.stations.lat[i]] as [number, number],
      tier: data.stations.tier[i],
      monitor: data.stations.monitor[i],
    }));
  }, [data]);

  const firePoints = useMemo(() => {
    if (!data) return [];
    return data.fires.lat.map((lat, i) => ({
      position: [data.fires.lon[i], lat] as [number, number],
      hour: data.fires.hour[i],
      frp: data.fires.frp[i],
    }));
  }, [data]);

  /** Wind is a grid; index by hour so the accessor only sees the current slice. */
  const windByHour = useMemo(() => {
    if (!data) return [];
    const buckets: { position: [number, number]; dir: number; speed: number }[][] = Array.from(
      { length: data.meta.hours },
      () => [],
    );
    for (let i = 0; i < data.wind.hour.length; i++) {
      const h = data.wind.hour[i];
      if (h < 0 || h >= buckets.length) continue;
      buckets[h].push({
        position: [data.wind.lon[i], data.wind.lat[i]],
        dir: data.wind.dir[i],
        speed: data.wind.speed[i],
      });
    }
    return buckets;
  }, [data]);

  const alertFeatures = useMemo(() => {
    if (!data) return { type: "FeatureCollection" as const, features: [] };
    return {
      type: "FeatureCollection" as const,
      features: data.alerts
        .filter((a) => a.fromHour <= cursorHour && (a.toHour === null || a.toHour >= cursorHour))
        .map((a) => ({
          type: "Feature" as const,
          geometry: a.geometry as never,
          properties: { event: a.event, severity: a.severity, headline: a.headline },
        })),
    };
  }, [data, cursorHour]);

  /**
   * Everything outside NWS coverage, drawn as the region with the US punched
   * out of it. Absence of alert coverage is rendered explicitly rather than
   * looking like absence of hazard — those are different claims.
   *
   * The holes come from the real national boundary shipped in the payload, not
   * a bounding rectangle: a rectangle puts Windsor and Vancouver inside "US
   * coverage", which is exactly the confusion this mask exists to prevent.
   */
  const coverageMask = useMemo(() => {
    if (!data) return [];
    // World extent, not the region box: NWS alerts do not exist anywhere
    // outside the US, and clipping the mask to the region left a hard
    // rectangle edge across Canada that read as a rendering artefact rather
    // than as a statement about coverage.
    const outer = [
      [-179.9, -84], [179.9, -84], [179.9, 84], [-179.9, 84], [-179.9, -84],
    ];

    const cov = data.meta.alertCoverage as
      | { type: string; coordinates: number[][][] | number[][][][] }
      | null;

    const holes: number[][][] = [];
    if (cov?.type === "Polygon") {
      holes.push((cov.coordinates as number[][][])[0]);
    } else if (cov?.type === "MultiPolygon") {
      for (const poly of cov.coordinates as number[][][][]) holes.push(poly[0]);
    } else {
      // Fall back to the coarse box only if the boundary failed to load, and
      // accept that it is approximate rather than silently drawing nothing.
      holes.push([
        [CONUS[0], CONUS[1]], [CONUS[0], CONUS[3]],
        [CONUS[2], CONUS[3]], [CONUS[2], CONUS[1]], [CONUS[0], CONUS[1]],
      ]);
    }

    return [{ polygon: [outer, ...holes] }];
  }, [data]);

  const hours = data?.meta.hours ?? 1;

  const rasterTiles = (id: string, url: string, opacity: number) =>
    new TileLayer<ImageBitmap>({
      id,
      data: url,
      minZoom: 0,
      maxZoom: 16,
      tileSize: 256,
      opacity,
      pickable: false,
      renderSubLayers: (props) => {
        const { boundingBox } = props.tile;
        // The sub-layer inherits `data` (the URL template) from the parent,
        // which BitmapLayer must not receive — it takes `image` instead.
        const { data: _url, ...rest } = props;
        return new BitmapLayer({
          ...rest,
          image: props.data,
          bounds: [
            boundingBox[0][0],
            boundingBox[0][1],
            boundingBox[1][0],
            boundingBox[1][1],
          ],
        });
      },
    });

  const deckLayers = data
    ? [
        rasterTiles("basemap", BASEMAP_TILES, 1),
        // Place names sit under the data, so they orient without competing.
        rasterTiles("basemap-labels", BASEMAP_LABELS, 0.75),

        layers.alerts &&
          new SolidPolygonLayer({
            id: "coverage-mask",
            data: coverageMask,
            getPolygon: (d: { polygon: number[][][] }) => d.polygon as never,
            getFillColor: [120, 133, 152, 78],
            pickable: true,
            parameters: { depthTest: false },
          }),

        layers.alerts &&
          new GeoJsonLayer({
            id: "alerts",
            data: alertFeatures as never,
            filled: true,
            stroked: true,
            getFillColor: [217, 119, 6, 30],
            getLineColor: [180, 83, 9, 210],
            getLineWidth: 1200,
            lineWidthMinPixels: 1,
            pickable: true,
          }),

        layers.fires &&
          new ScatterplotLayer({
            id: "fires",
            data: firePoints,
            getPosition: (d: { position: [number, number] }) => d.position,
            getRadius: (d: { frp: number }) => fireRadius(d.frp),
            radiusMinPixels: 1.5,
            radiusMaxPixels: 26,
            /**
             * Time filtering happens HERE — in the accessor, against buffers
             * already uploaded to the GPU — not by re-slicing firePoints and
             * rebuilding the layer. That distinction is the whole reason
             * deck.gl is in this build rather than Leaflet.
             */
            getFillColor: (d: { hour: number; frp: number }) => {
              const age = cursorHour - d.hour;
              if (age < 0) return [0, 0, 0, 0]; // future relative to the cursor
              const alpha = age === 0 ? 255 : Math.max(0, 235 - age * 9);
              if (alpha <= 0) return [0, 0, 0, 0];
              const [r, g, b] = fireColor(d.frp);
              return [r, g, b, alpha];
            },
            updateTriggers: { getFillColor: cursorHour },
            pickable: true,
          }),

        layers.wind &&
          new LineLayer({
            id: "wind",
            data: windByHour[cursorHour] ?? [],
            getSourcePosition: (d: { position: [number, number] }) => d.position,
            // wind_direction is the direction wind comes FROM, so the barb
            // points toward dir + 180.
            getTargetPosition: (d: { position: [number, number]; dir: number; speed: number }) => {
              const rad = ((d.dir + 180) * Math.PI) / 180;
              const len = Math.min(1.4, 0.25 + d.speed / 40);
              return [
                d.position[0] + Math.sin(rad) * len,
                d.position[1] + Math.cos(rad) * len,
              ] as [number, number];
            },
            getColor: [37, 99, 235, 130],
            getWidth: 1.4,
            widthMinPixels: 1,
          }),

        layers.pm25 &&
          pmGrid &&
          new ScatterplotLayer({
            id: "pm25",
            data: stationPoints,
            getPosition: (d: { position: [number, number] }) => d.position,
            radiusMinPixels: 3.5,
            radiusMaxPixels: 13,
            getRadius: 14000,
            stroked: true,
            lineWidthMinPixels: 1.4,
            getFillColor: (d: { index: number }) => {
              const i = d.index * hours + cursorHour;
              const v = pmGrid[i];
              // Absent stations render as hollow rings rather than vanishing:
              // a missing reading is information. Carried-forward readings fade
              // with age, so "measured now" and "measured two hours ago" are
              // visibly different.
              if (Number.isNaN(v)) return [0, 0, 0, 0];
              const [r, g, b] = aqiBand(v).rgb;
              const age = pmAge ? pmAge[i] : 0;
              return [r, g, b, age === 0 ? 235 : Math.max(70, 235 - age * 55)];
            },
            getLineColor: (d: { index: number; id: number }) => {
              if (d.id === focusStationId) return [17, 24, 39, 255];
              const v = pmGrid[d.index * hours + cursorHour];
              if (Number.isNaN(v)) return [150, 158, 170, 190];
              const [r, g, b] = aqiBand(v).rgb;
              return [r, g, b, 255];
            },
            updateTriggers: {
              getFillColor: cursorHour,
              getLineColor: [cursorHour, focusStationId],
            },
            pickable: true,
            onClick: (info: PickingInfo) => {
              const d = info.object as { id: number } | undefined;
              if (d) setFocusStation(d.id);
            },
          }),
      ].filter(Boolean)
    : [];

  return (
    <DeckGL
      viewState={viewState}
      controller={{ dragRotate: false }}
      layers={deckLayers as never}
      onViewStateChange={(e) => {
        const vs = e.viewState as MapViewState;
        setViewState(vs);
        if (!onViewportChange) return;
        // Report the visible box so zooming can request a finer detail level.
        // Clamped: zoomed fully out this maths runs past ±90° latitude, which
        // PostGIS refuses.
        const span = 360 / 2 ** vs.zoom;
        const bbox = clampBBox([
          vs.longitude - span,
          vs.latitude - span / 2,
          vs.longitude + span,
          vs.latitude + span / 2,
        ]);
        const key = bbox.map((n) => n.toFixed(1)).join(",");
        if (key !== lastBBox.current) {
          lastBBox.current = key;
          onViewportChange(bbox);
        }
      }}
      getTooltip={({ object, layer }: PickingInfo) => {
        if (!object) return null;
        if (layer?.id === "pm25") {
          const d = object as { index: number; name: string; tier: string; monitor: boolean };
          const i = d.index * hours + cursorHour;
          const v = pmGrid ? pmGrid[i] : NaN;
          const age = pmAge ? pmAge[i] : 255;
          const band = aqiBand(Number.isNaN(v) ? null : v);
          return {
            html:
              `<div style="font-weight:600;margin-bottom:2px">${escapeHtml(d.name)}</div>` +
              `<div>${
                Number.isNaN(v)
                  ? "No reading at this hour"
                  : `${v.toFixed(1)} µg/m³ — ${band.label}`
              }</div>` +
              (!Number.isNaN(v) && age > 0
                ? `<div style="opacity:.65">measured ${age}h earlier — carried forward</div>`
                : "") +
              `<div style="opacity:.6;margin-top:3px">${
                d.monitor ? "Reference monitor" : "Low-cost sensor"
              } · tier ${d.tier}</div>`,
            style: tooltipStyle,
          };
        }
        if (layer?.id === "fires") {
          const d = object as { frp: number; hour: number };
          return {
            html:
              `<div style="font-weight:600">Fire detection</div>` +
              `<div>${d.frp.toFixed(1)} MW radiative power</div>` +
              `<div style="opacity:.6;margin-top:3px">${cursorHour - d.hour}h before cursor</div>`,
            style: tooltipStyle,
          };
        }
        if (layer?.id === "alerts") {
          const p = (object as { properties?: Record<string, string> }).properties ?? {};
          return {
            html:
              `<div style="font-weight:600">${escapeHtml(p.event ?? "Alert")}</div>` +
              `<div style="max-width:260px">${escapeHtml(p.headline ?? "")}</div>`,
            style: tooltipStyle,
          };
        }
        if (layer?.id === "coverage-mask") {
          return {
            html:
              `<div style="font-weight:600">No NWS alert coverage</div>` +
              `<div style="max-width:250px">NWS issues alerts for US territory only. ` +
              `This is missing coverage, not an absence of hazard.</div>`,
            style: tooltipStyle,
          };
        }
        return null;
      }}
    >
      <div className="bg-surface/85 text-ink-3 pointer-events-none absolute right-1 bottom-1 z-10 rounded px-1.5 py-0.5 text-[9px]">
        Basemap © Esri, HERE, Garmin, NGA, USGS
      </div>
    </DeckGL>
  );
}

const tooltipStyle = {
  backgroundColor: "rgba(255,255,255,.98)",
  color: "#12171f",
  fontSize: "11px",
  padding: "7px 9px",
  borderRadius: "6px",
  border: "1px solid #cbd3de",
  lineHeight: "1.45",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}
