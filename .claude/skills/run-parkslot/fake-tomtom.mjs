// Local stand-in for TomTom Flow Segment Data (documented response format), for trying traffic pricing
// without an API key. Congestion is derived from the point, so it is stable per lot.
import { createServer } from 'node:http';
const port = Number(process.argv[2] ?? 4555);
let calls = 0;
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/traffic/services/4/flowSegmentData/')) return res.writeHead(404).end();
  calls++;
  const [lat, lng] = url.searchParams.get('point').split(',').map(Number);
  const h = Math.abs(Math.sin(lat * 1000) * Math.cos(lng * 1000));       // 0..1, stable per point
  const freeFlowSpeed = 60;
  const roadClosure = h > 0.97;
  const currentSpeed = Math.round(freeFlowSpeed * (1 - 0.85 * h));
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
    flowSegmentData: { frc: 'FRC2', currentSpeed, freeFlowSpeed, currentTravelTime: 100, freeFlowTravelTime: 60, confidence: 0.9, roadClosure },
  }));
  console.log(`call ${calls}: ${lat},${lng} -> ${currentSpeed}/${freeFlowSpeed}${roadClosure ? ' CLOSED' : ''}`);
}).listen(port, '127.0.0.1', () => console.log(`fake TomTom on ${port}`));
