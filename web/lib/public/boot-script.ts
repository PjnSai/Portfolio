// The one hand-written inline script. It runs in <head>, before the body is
// parsed, so the page never paints in the wrong palette or theme, and so the
// contact form can never be sent by the browser itself, even before any other
// code has arrived (the form's own code sends it; see ContactForm). The root
// layout puts the owner's choice on <html>: data-palette (the default),
// data-palette-mode and data-palettes (the enabled ids). The text must stay
// exactly as it is here: its SHA-256 is in EXTRA_SCRIPT_HASHES and
// tests/boot-script.test.ts fails if the two drift apart.
// No imports: tests run this text as it is.

/** localStorage keys, and the sessionStorage key that marks a visit for rotation. */
export const KEYS = {
  palette: "palette",
  lastPalette: "palette-last",
  theme: "theme",
  visit: "palette-visit",
} as const;

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const BOOT_SCRIPT = `(function(){
var d=document.documentElement,a=d.dataset,p=a.palette,m=a.paletteMode;
var ids=(a.palettes||"").split(" ").filter(Boolean);
function store(n){try{return window[n]}catch(e){return null}}
var L=store("localStorage"),S=store("sessionStorage");
function get(s,k){try{return s?s.getItem(k):null}catch(e){return null}}
function put(s,k,v){try{if(s)s.setItem(k,v)}catch(e){}}
function ok(v){return v!==null&&ids.indexOf(v)>=0}
if(m==="pick"){var c=get(L,"palette");if(ok(c))p=c}
else if(m==="rotate"&&ids.length>1){var v=get(S,"palette-visit");
if(ok(v))p=v;else{var l=get(L,"palette-last");
if(ok(l))p=ids[(ids.indexOf(l)+1)%ids.length];
put(L,"palette-last",p);put(S,"palette-visit",p)}}
if(p)a.palette=p;
var t=get(L,"theme");a.theme=t==="light"||t==="dark"?t:"system";
document.addEventListener("submit",function(e){var f=e.target;
if(f&&f.id==="contact-form")e.preventDefault()},true)})()`;
