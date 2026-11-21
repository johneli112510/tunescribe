import { transcribeMelody } from '../public/js/transcribe.js';
import { detectKey, keyLabel, estimateTempo, buildMusicXML, buildMidi } from '../public/js/music.js';

const sr=22050, bpm=120, b=60/bpm;
// Ode to joy-ish melody in G major: quarter notes, with a half note
const mel=[71,71,72,74,74,72,71,69,67,67,69,71,71,69,69];
const durs=[1,1,1,1,1,1,1,1,1,1,1,1,1.5,0.5,2];
let t=0.3; const notes=[]; for(let i=0;i<mel.length;i++){notes.push({start:t,dur:durs[i]*b*0.9,pitch:mel[i]});t+=durs[i]*b;}
const x=new Float32Array(Math.ceil((t+0.5)*sr));
for(const n of notes){const f=440*2**((n.pitch-69)/12);const s0=Math.floor(n.start*sr),L=Math.floor(n.dur*sr);for(let i=0;i<L;i++){const env=Math.min(1,i/200)*Math.exp(-i/sr*1.5);x[s0+i]+=0.4*env*(Math.sin(2*Math.PI*f*i/sr)+0.4*Math.sin(4*Math.PI*f*i/sr));}}
const t0=Date.now();
const got=await transcribeMelody(x,sr,{});
console.log('ms',Date.now()-t0,'found',got.length, got.map(n=>n.pitch).join(','));
console.log(got.slice(0,3));
const tempo=estimateTempo(got); console.log(tempo);
const k=detectKey(got); console.log(keyLabel(k.fifths,k.mode));
const opt={...tempo,beats:4,beatType:4,grid:4,layout:'auto',split:60,...k,title:'Test & <x>'};
const xml=buildMusicXML(got,opt); 
const xml2=buildMusicXML([...got,{start:1,dur:2.3,pitch:43,vel:80},{start:1,dur:0.3,pitch:48}],{...opt,layout:'grand',beats:3,fifths:-3,mode:'minor'}); if(!xml2.includes('<backup>'))throw new Error('no backup');
const mid=buildMidi(got,opt); console.log('midi bytes',mid.length);
