-- Widen the coverage column from Polygon to any geography type.
--
-- The NWS coverage boundary was originally a CONUS bounding rectangle, which is
-- wrong exactly where it matters: that box reaches 49.5°N and so swallows
-- Vancouver BC, and no rectangle can separate Michigan from Ontario. The real
-- US boundary is a MultiPolygon (Alaska, Hawaii, islands), so the typmod has to
-- allow it. See scripts/set-coverage.ts.

alter table sources
  alter column coverage_geom type geography
  using coverage_geom::geography;
