// Fixed routes drawn over both maps (nyc-map.js keeps a list, mapSystem.overlayRoutes, and draws each with this):
// the swimming clip's drive, added by swim-controls.js.

// A fixed route over the map: a dashed line on a dark `halo` casing, its start a ring
function drawOverlayRoute(ctx, route, toX, toY, width, halo) {
  if (route.points.length < 2) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  route.points.forEach((p, i) => (i ? ctx.lineTo(toX(p.x), toY(p.z)) : ctx.moveTo(toX(p.x), toY(p.z))));
  ctx.strokeStyle = halo;
  ctx.lineWidth = width + 3;
  ctx.stroke();
  ctx.setLineDash([width * 2.4, width * 1.4]);
  ctx.strokeStyle = route.color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.setLineDash([]);
  const start = route.points[0];
  ctx.beginPath();
  ctx.arc(toX(start.x), toY(start.z), width + 2.5, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

export { drawOverlayRoute };
