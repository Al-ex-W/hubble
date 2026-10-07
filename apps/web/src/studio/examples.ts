export const EXAMPLES = [
  {
    title: 'Wave laboratory',
    prompt: 'An interactive sine wave with frequency and amplitude controls.',
    source: `export default function WaveLaboratory() {
  const [frequency, setFrequency] = React.useState(2);
  const [amplitude, setAmplitude] = React.useState(0.65);
  const points = Array.from({length: 160}, (_, i) => {
    const x = i / 159 * 560;
    return x + ',' + (80 - Math.sin(i / 159 * Math.PI * 2 * frequency) * amplitude * 65);
  }).join(' ');
  return <UI.Stack>
    <UI.Row><UI.Badge>MATHEMATICS</UI.Badge><UI.Text muted size="small">Live function</UI.Text></UI.Row>
    <UI.Heading>A little change. A new wave.</UI.Heading>
    <UI.Math tex={'y = A\\\\sin(2\\\\pi f x)'} />
    <svg viewBox="0 0 560 160" aria-label="Interactive sine wave" style={{width:'100%', color:'var(--liquid-accent)'}}>
      <path d="M0 80H560 M280 0V160" stroke="var(--liquid-line)" fill="none" />
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
    <UI.Slider label="Frequency" value={frequency} min={0.5} max={6} step={0.1} unit="Hz" onChange={setFrequency} />
    <UI.Slider label="Amplitude" value={amplitude} min={0.1} max={1} step={0.05} onChange={setAmplitude} />
  </UI.Stack>;
}`,
  },
  {
    title: 'Focus timer',
    prompt: 'A focus timer with start, pause, reset and independently managed interval state.',
    source: `export default function FocusTimer() {
  const [seconds, setSeconds] = React.useState(25 * 60);
  const [running, setRunning] = React.useState(false);
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setSeconds(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [running]);
  React.useEffect(() => { if (seconds === 0) setRunning(false); }, [seconds]);
  const time = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  return <UI.Stack>
    <UI.Row><UI.Badge>MAKE SPACE</UI.Badge><UI.Text muted size="small">One thing at a time</UI.Text></UI.Row>
    <UI.Heading>A moment to focus.</UI.Heading>
    <UI.Stat label={running ? 'Your session is flowing' : 'Ready when you are'} value={time} />
    <UI.Progress value={(1500-seconds)/1500*100} />
    <UI.Row>
      <UI.Button onClick={() => setRunning(v => !v)}>{running ? 'Pause' : 'Begin session'}</UI.Button>
      <UI.Button variant="quiet" onClick={() => {setRunning(false); setSeconds(1500);}}>Reset</UI.Button>
    </UI.Row>
    <UI.Text muted size="small">This timer keeps its state when you add another component.</UI.Text>
  </UI.Stack>;
}`,
  },
  {
    title: 'Room atmosphere',
    prompt: 'An interactive local lighting palette concept. Preview only; no physical Hue commands.',
    source: `export default function Atmosphere() {
  const [mood, setMood] = React.useState('Aurora');
  const [brightness, setBrightness] = React.useState(72);
  const colors = {Aurora: '#a4bcff', Ember: '#f4bd93', Forest: '#a0d9bc'};
  return <UI.Stack>
    <UI.Row><UI.Badge>ATMOSPHERE</UI.Badge><UI.Text muted size="small">Palette preview</UI.Text></UI.Row>
    <UI.Heading>Set the feeling.</UI.Heading>
    <div style={{height:96, borderRadius:24, background:'radial-gradient(ellipse at center,' + colors[mood] + '88, transparent 72%)', opacity:brightness/100}} />
    <UI.Tabs options={Object.keys(colors)} value={mood} onChange={setMood} />
    <UI.Slider label="Intensity" value={brightness} min={10} max={100} unit="%" onChange={setBrightness} />
    <UI.Text muted size="small">A visual sketch for the room. Physical lights are not connected.</UI.Text>
  </UI.Stack>;
}`,
  },
]
