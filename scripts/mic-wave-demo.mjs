import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { WebSocket, WebSocketServer } from 'ws'
import { build } from 'esbuild'

const orbBundle = (await build({ entryPoints: ['scripts/mic-orb-runtime.ts'], bundle: true, write: false, format: 'iife', minify: true })).outputFiles[0].text

const listenerPort = Number(process.env.MIC_LISTENER_PORT ?? 8795)
const rendererPort = Number(process.env.MIC_RENDERER_PORT ?? 8796)
const page = (title, body, script) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#0c1020;color:#edf0ff;font:18px system-ui,sans-serif}body{padding:4vw;background:radial-gradient(ellipse at 15% 20%,#7378cf22,transparent 65%),#0c1020}h1{font-size:clamp(28px,4vw,62px);font-weight:500;letter-spacing:-.05em;margin:0 0 12px}p{color:#a8aec8;line-height:1.6}button{background:#becaff;color:#191f3b;border:0;border-radius:14px;padding:14px 24px;font:inherit;cursor:pointer}button:disabled{opacity:.4}canvas{display:block;width:100%;height:45vh;border:1px solid #d8e0ff26;border-radius:24px;background:#21274088;margin:24px 0}.stats{display:flex;gap:24px;flex-wrap:wrap}.stats>div{background:#ffffff07;border:1px solid #d8e0ff26;padding:18px 24px;border-radius:18px;min-width:180px}.stats strong{display:block;font-size:36px;font-variant-numeric:tabular-nums}.stats span{color:#a8aec8;font-size:14px}#status{color:#becaff}#error{color:#ffb9b6}small{color:#a8aec8}a{color:#becaff}
canvas{width:min(100%,34vh);height:min(34vh,90vw);margin:24px auto;background:transparent;border:0;border-radius:0}
</style></head><body>${body}<script>${script}</script></body></html>`

const draw = orbBundle
const listenerHtml = page('Hubble microphone listener', `
<h1>Talk. Watch Hubble move.</h1><p>Microphone → listener :${listenerPort} → renderer :${rendererPort} → Raspberry Pi TV.<br>Audio samples stream at 60 Hz. The Hubble orb animates at display refresh rate.</p>
<button id="start">Start microphone</button> <button id="stop" disabled>Stop</button><p id="status">Ready for microphone permission</p><p id="error" role="alert"></p>
<canvas aria-label="Live microphone waveform"></canvas><div class="stats"><div><strong id="level">0%</strong><span>Microphone level (RMS)</span></div><div><strong id="seq">0</strong><span>Captured frame</span></div><div><strong id="rtt">—</strong><span>Relay → TV render ack RTT</span></div><div><strong id="viewers">0</strong><span>Connected renderer screens</span></div></div>
<p>Open the renderer on the TV. RTT includes transmission, browser draw scheduling and return acknowledgement; it is not one-way latency or measured screen refresh.</p>
`, `${draw}
let socket,context,stream,timer,seq=0,last=0;
function stop(){clearInterval(timer);timer=null;stream?.getTracks().forEach(t=>t.stop());stream=null;context?.close();context=null;socket?.close();socket=null;document.querySelector('#start').disabled=false;document.querySelector('#stop').disabled=true;document.querySelector('#status').textContent='Stopped'}
document.querySelector('#stop').onclick=stop;
document.querySelector('#start').onclick=async()=>{document.querySelector('#start').disabled=true;document.querySelector('#error').textContent='';try{
stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});context=new AudioContext({latencyHint:'interactive'});await context.resume();const analyser=context.createAnalyser();analyser.fftSize=512;analyser.smoothingTimeConstant=0;context.createMediaStreamSource(stream).connect(analyser);const values=new Float32Array(analyser.fftSize),frequency=new Uint8Array(analyser.frequencyBinCount);
socket=new WebSocket('ws://'+location.host+'/mic');await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=()=>reject(new Error('Listener connection failed'))});socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='stats'){document.querySelector('#rtt').textContent=m.rtt==null?'—':m.rtt.toFixed(1)+' ms';document.querySelector('#viewers').textContent=m.viewers}};
socket.onclose=()=>{if(timer)stop()};document.querySelector('#stop').disabled=false;document.querySelector('#status').textContent='Microphone live · sending 60 updates/s';
timer=setInterval(()=>{analyser.getFloatTimeDomainData(values);analyser.getByteFrequencyData(frequency);let energy=0;for(const v of values)energy+=v*v;const frame={seq:++seq,rms:Math.sqrt(energy/values.length),spectrum:Array.from({length:128},(_,i)=>frequency[Math.min(frequency.length-1,Math.round((100+i/127*7900)/(context.sampleRate/analyser.fftSize)))])};window.draw(frame);if(socket.readyState===1&&socket.bufferedAmount===0)socket.send(JSON.stringify(frame))},1000/60);
}catch(e){stop();document.querySelector('#error').textContent=e.message}};
window.addEventListener('beforeunload',stop);
`)

const rendererHtml = page('Hubble live TV waveform', `
<h1>Your voice. Live on the Pi.</h1><p id="status">Connecting to renderer…</p><canvas aria-label="Live relayed microphone waveform"></canvas>
<div class="stats"><div><strong id="level">0%</strong><span>Microphone RMS</span></div><div><strong id="seq">0</strong><span>Latest audio frame</span></div><div><strong id="fps">0</strong><span>Actual orb animation FPS · target 60</span></div><div><strong id="rtt">—</strong><span>Relay → render ack RTT</span></div></div><p>60 Hz audio relay · original Hubble WebGL orb · <span id="quality">Native resolution</span><br><small>RTT includes network and browser scheduling, not physical display refresh.</small></p>
`, `${draw}
let pending=null,rendered=0,count=0,last=performance.now(),lastFrame=0;
function connect(){const ws=new WebSocket('ws://'+location.host+'/display');ws.onopen=()=>document.querySelector('#status').textContent='Connected · waiting for microphone';ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='frame'){pending=m;lastFrame=performance.now()}if(m.type==='stats')document.querySelector('#rtt').textContent=m.rtt==null?'—':m.rtt.toFixed(1)+' ms'};ws.onclose=()=>{document.querySelector('#status').textContent='Disconnected · reconnecting';setTimeout(()=>{socket=connect()},1000)};return ws}let socket=connect();
// Only the latest received frame reaches a paint. A second animation callback
// acknowledges after the draw had a rendering opportunity, not just WS arrival.
function animate(){if(pending){const frame=pending;pending=null;window.draw(frame);rendered=frame.seq;document.querySelector('#status').textContent='Live microphone · Hubble orb';requestAnimationFrame(()=>{if(socket.readyState===1)socket.send(JSON.stringify({type:'rendered',relay:frame.relay,seq:frame.seq,fps:window.orbFPS}))})}const now=performance.now();if(lastFrame&&now-lastFrame>2000)document.querySelector('#status').textContent='Connected · microphone paused';requestAnimationFrame(animate)}animate();
`)

function http(html) {
  return createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return }
    if (req.url === '/metrics') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ screens: [...screenMetrics.values()], rtt })); return }
    if (req.url !== '/') { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html)
  })
}
const renderer = http(rendererHtml)
const ingest = new WebSocketServer({ noServer: true, maxPayload: 32_000 })
const screens = new WebSocketServer({ noServer: true, maxPayload: 2000 })
const screenMetrics = new Map()
const relayTimes = new Map()
let relaySeq = 0, rtt = null, upstream
renderer.on('upgrade', (req, socket, head) => {
  const wss = req.url === '/ingest' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.remoteAddress) ? ingest : req.url === '/display' ? screens : null
  if (!wss) return socket.destroy()
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})
function stats() {
  const message = JSON.stringify({ type: 'stats', rtt, viewers: screens.clients.size })
  if (upstream?.readyState === WebSocket.OPEN) upstream.send(message)
  for (const ws of screens.clients) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 64_000) ws.send(message)
}
ingest.on('connection', ws => {
  upstream = ws
  ws.on('message', data => {
    let frame
    try { frame = JSON.parse(data.toString()) } catch { return }
    if (!Number.isInteger(frame.seq) || !Number.isFinite(frame.rms) || frame.rms<0 || frame.rms>1) return
    if (!Array.isArray(frame.spectrum) || frame.spectrum.length !== 128 || !frame.spectrum.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) return
    const relay = ++relaySeq
    relayTimes.set(relay, performance.now())
    while (relayTimes.size > 120) relayTimes.delete(relayTimes.keys().next().value)
    const message = JSON.stringify({ ...frame, type: 'frame', relay })
    for (const client of screens.clients) if (client.readyState === WebSocket.OPEN && client.bufferedAmount === 0) client.send(message)
  })
})
screens.on('connection', ws => {
  stats()
  ws.on('message', data => {
    let ack
    try { ack = JSON.parse(data.toString()) } catch { return }
    if (ack.type !== 'rendered') return
    screenMetrics.set(ws, { fps: ack.fps, frame: ack.seq, rtt: relayTimes.has(ack.relay) ? performance.now()-relayTimes.get(ack.relay) : null })
    const start = relayTimes.get(ack.relay)
    if (start !== undefined) { rtt = performance.now() - start }
  })
  ws.on('close', () => { screenMetrics.delete(ws); stats() })
})
renderer.listen(rendererPort, '0.0.0.0', () => console.log(`TV renderer: http://0.0.0.0:${rendererPort}`))
// HUD updates are diagnostic, not another 60 Hz back-and-forth stream competing
// with the signal. Ten updates per second are enough to read the numbers.
setInterval(stats, 100)

const listener = http(listenerHtml)
const microphones = new WebSocketServer({ server: listener, path: '/mic', maxPayload: 32_000 })
let bridge
function connectBridge() {
  bridge = new WebSocket(`ws://127.0.0.1:${rendererPort}/ingest`)
  bridge.on('error', () => {})
  bridge.on('close', () => setTimeout(connectBridge, 1000))
  bridge.on('message', data => { for (const ws of microphones.clients) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 64_000) ws.send(data.toString()) })
}
connectBridge()
microphones.on('connection', ws => ws.on('message', data => {
  if (bridge.readyState === WebSocket.OPEN && bridge.bufferedAmount === 0) bridge.send(data.toString())
}))
listener.listen(listenerPort, '0.0.0.0', () => console.log(`Microphone listener: http://localhost:${listenerPort}`))
