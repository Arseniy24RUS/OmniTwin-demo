export function gamePixelRatio(tier:'low'|'medium'|'high',deviceRatio:number,width:number,height:number):number {
  const pixels=tier==='low'?1_048_576:tier==='high'?8_388_608:4_194_304;
  const ceiling=tier==='low'?1:tier==='high'?2.5:2;
  const native=Number.isFinite(deviceRatio)&&deviceRatio>0?deviceRatio:1;
  const area=Math.max(1,Number.isFinite(width)?width:1)*Math.max(1,Number.isFinite(height)?height:1);
  // Quantization prevents tiny layout changes from reallocating the drawing buffer.
  const budget=Math.floor(Math.sqrt(pixels/area)*16)/16;
  return Math.max(1/16,Math.min(native,ceiling,budget));
}
