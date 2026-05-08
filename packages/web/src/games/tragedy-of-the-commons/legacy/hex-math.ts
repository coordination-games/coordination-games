export function hexToPixel(q: number, r: number, centerX: number, centerY: number, size: number) {
  return {
    x: centerX + size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
    y: centerY + size * (1.5 * r),
  };
}

export function drawHexPath(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.beginPath();
  for (let corner = 0; corner < 6; corner++) {
    const angle = (Math.PI / 3) * corner - Math.PI / 6;
    const px = x + size * Math.cos(angle);
    const py = y + size * Math.sin(angle);
    if (corner === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}
