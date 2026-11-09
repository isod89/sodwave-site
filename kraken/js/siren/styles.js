// SPDX-License-Identifier: GPL-3.0-only
// Kraken's styles for SIREN's brain (siren/brain.js): what SIREN's eight styles do not cover, each written as a
// grammar of the same kind (a tempo range, scales, chord progressions, a groove, a bass, which layers play, a form),
// with what the brain did not have yet behind its own switches: grooves (the backbeat, rock, boom bap, trap, drill,
// R&B, the dembow, afrobeats, amapiano, the two-step, a film score's drums, none), basses (808s and their slides, a
// walking bass, octaves, the log drum, a cello ostinato…), comping (a piano's or a guitar's chords in a rhythm),
// sevenths, and a song's form (verses, pre-choruses, choruses, a bridge). The brain's rules stay the brain's: a seed,
// streams of its own for each layer, chances per mille, the energy of each section.
// How they were made: from how records in each style are built (their tempo, their drum patterns, where the bass sits,
// how long an intro is, what a chorus does), the same way SIREN's grammars were.

// ------------------------------------------------------------------------------------------- the helpers ---
const euclid = (k, n, rot, i) => (((i + n - (rot % n)) * k) % n) < k;
const two = (a, b = a) => [...a, ...b.map((i) => i + 16)];          // (a two-bar pattern from two bars)
const div = (a, b) => Math.trunc(a / b);
export const VOICES = {
  triad: [0, 2, 4],                // (SIREN's stabs)
  seventh: [0, 2, 4, 6],           // (R&B, lo-fi, house keys)
  power: [0, 4, 7],                // (rock: root, fifth, octave)
  wide: [0, 4, 7, 9],              // (future bass: a spread supersaw chord)
  open: [0, 4, 9],                 // (pop piano, open)
};

// ---------------------------------------------------------------------------------------- the grammars ---
// SIREN's fields (siren/brain.js STYLES), and Kraken's:
//   song        a song's form (songForm, below) instead of a rave's
//   softBuild   a build that keeps the groove and ends on a fill (a pre-chorus), not SIREN's roll and sweep
//   comp        the stabs as comping: rhythms [[step, length, velocity?]]; compVoice, compBase (its voicing, its octave)
//   compAlso    the comping plays in the verses and builds too, not only the drops
//   pad7        the chance (per mille) the chords are sevenths
//   bassBase    the bass's octave (MIDI note of its C: 36 SIREN's, 24 an 808)
//   hookDens    the hook's density (per mille: a sparse piano, a busy cowbell)
//   labels      how the song calls its sections (the brain's GROOVE, BUILD, DROP, PEAK, BREAK)
const SONG = { GROOVE: 'VERSE', BUILD: 'PRE-CHORUS', DROP: 'CHORUS', PEAK: 'LAST CHORUS', BREAK: 'BRIDGE' };
const RAP = { GROOVE: 'VERSE', BUILD: 'PRE-HOOK', DROP: 'HOOK', PEAK: 'LAST HOOK', BREAK: 'BRIDGE' };
const base = { breakDrums: 0, rumble: 0, kitTune: 0, sub: 0, dropBass: 0, gallop: 0, swing: 0, ride: 0, roll: 'snare', percLanes: ['rim', 'shake'], hatModes: ['8'], hats: [4, 8] };
const S = (o) => ({ ...base, ...o });

export const EXT_STYLES = {
  // ---- electronic
  // DUBSTEP: SIREN's own half time (the prototype's), its wobble, riddim and growl basses that change sound inside a
  // drop, a sub under them; minor and phrygian, one chord for long
  DUBSTEP: S({ groove: 'half', kitTune: 1, sub: 900, dropBass: 1, bpm: [140, 140], scales: ['minor', 'phrygian'], progs: [[0], [0, 5], [0, 3, 5, 4], [0, 6]], chordBars: 4,
    bass: ['wobble', 'growl', 'riddim'], layers: [150, 700, 700, 150, 1000, 0], hats: [5, 9], ride: 200, percLanes: ['rim', 'shake'], hatModes: ['8', '16gap'] }),
  // FUTURE BASS: half time, supersaw chords pumping in a syncopated rhythm (the drop belongs to them), a sub on the
  // root, major (IV V iii vi) or minor, bright plucks
  FUTUREBASS: S({ groove: 'half', kitTune: 1, sub: 600, bpm: [145, 155], scales: ['major', 'major', 'minor'], progs: [[3, 4, 2, 5], [5, 3, 0, 4], [0, 4, 5, 3], [3, 4, 5, 5]], chordBars: 1,
    bass: ['chordsub'], layers: [600, 900, 600, 1000, 1000, 0], hats: [4, 8], hatModes: ['8', '16gap'], ride: 100, percLanes: ['shake', 'rim'],
    comp: [[[0, 3], [3, 3], [6, 2], [10, 2], [12, 4]], [[0, 2], [3, 2], [6, 3], [10, 2], [14, 2]], [[0, 4], [6, 2], [8, 3], [12, 2], [14, 2]]], compVoice: 'wide', compBase: 60, pad7: 300 }),
  // UK GARAGE: the two-step (the kick on 1 and the and of 3), shuffled skippy hats, organ stabs, a bouncing sub bass
  // with octave jumps; minor sevenths
  UKG: S({ groove: '2step', kitTune: 1, breakDrums: 1, bpm: [130, 134], scales: ['minor', 'dorian'], progs: [[0, 3], [0, 5, 3, 4], [0, 6, 5, 6], [0, 3, 0, 4]], chordBars: 2,
    bass: ['garage'], swing: 220, layers: [200, 700, 600, 900, 900, 0], hats: [7, 11], percLanes: ['rim', 'shake', 'clave'], pad7: 700 }),
  // DISCO: four on the floor, the open hat on every offbeat, the octave bass, strings and a clavinet's stabs; major,
  // dorian vamps, ii V I vi
  DISCO: S({ groove: 'four', bpm: [116, 122], scales: ['major', 'dorian', 'minor'], progs: [[1, 4, 0, 5], [0, 3], [5, 3, 4, 0], [0, 0, 3, 4]], chordBars: 2,
    bass: ['octave'], swing: 40, layers: [400, 800, 900, 900, 600, 0], hats: [4, 8], hatModes: ['off8', '16'], ride: 100, percLanes: ['conga', 'shake', 'clave'], pad7: 400 }),
  // SYNTHWAVE: the eighties' backbeat (a big snare on 2 and 4), eighth-note synth bass, arpeggios, Juno pads, a soaring
  // lead; minor (i VI III VII), verses and choruses
  SYNTHWAVE: S({ groove: 'back', bpm: [96, 112], scales: ['minor', 'dorian'], progs: [[0, 5, 2, 6], [0, 6, 5, 6], [5, 6, 0, 0], [0, 3, 5, 4]], chordBars: 2,
    bass: ['synth8'], layers: [900, 900, 1000, 300, 800, 0], hats: [4, 8], hatModes: ['8', '16'], percLanes: ['clap', 'rim'], softBuild: 1, labels: SONG,
    song: { intro: [8, 16], verse: [16], pre: [8], pPre: 500, chorus: [16], post: [8], pPost: 300, bridge: [8, 16], pBridge: 700, pPeak: 800, cyc: [2, 3], outro: [8, 16], maxBars: 128 } }),
  // CHIPTUNE: a game's loop: four to the floor's cousin (kick on 1 and 3), fast arpeggios always, an octave-jumping
  // bass, a square lead; major or minor, a chord a bar
  CHIPTUNE: S({ groove: 'back', bpm: [140, 160], scales: ['major', 'minor'], progs: [[0, 3, 4, 0], [0, 5, 3, 4], [5, 3, 0, 4], [0, 4, 5, 3]], chordBars: 1,
    bass: ['chip'], layers: [1000, 1000, 300, 200, 300, 0], hats: [6, 10], hatModes: ['8', '16'], percLanes: ['rim'], softBuild: 1, labels: { GROOVE: 'A', BUILD: 'RISE', DROP: 'B', PEAK: 'FINAL B', BREAK: 'C' },
    song: { intro: [4, 8], verse: [8, 16], pre: [4], pPre: 300, chorus: [16], post: [8], pPost: 200, bridge: [8], pBridge: 500, pPeak: 700, cyc: [2, 3], outro: [4, 8], maxBars: 112 } }),
  // ---- hip-hop & R&B
  // HIP-HOP: boom bap: the kick's pattern over two bars, the snare on 2 and 4 with its ghosts, swung eighth hats;
  // Rhodes sevenths, a walking or kick-following bass, a sampled hook; intro, verses of 16, hooks of 8
  HIPHOP: S({ groove: 'boom', breakDrums: 1, bpm: [86, 94], scales: ['minor', 'dorian'], progs: [[0, 3], [0, 5, 3, 4], [0, 6, 5, 4], [0, 0, 5, 5]], chordBars: 2,
    bass: ['walk', 'kick'], swing: 220, layers: [100, 900, 1000, 300, 200, 0], pad7: 800, softBuild: 1, labels: RAP,
    song: { intro: [4, 8], verse: [16], pre: [4], pPre: 0, chorus: [8], post: [8], pPost: 0, bridge: [8], pBridge: 300, pPeak: 500, cyc: [2, 3], outro: [4, 8], maxBars: 96 } }),
  // TRAP: half time at 140 (the clap on 3), a two-bar kick, eighth hats with 16th, 32nd and triplet rolls, the 808 on
  // the kick and sliding; dark minor, a bell or piano melody, a dark pad
  TRAP: S({ groove: 'trap', bpm: [136, 150], scales: ['minor', 'harmonic', 'phrygian'], progs: [[0], [0, 5], [0, 3], [0, 6, 5, 6], [0, 1]], chordBars: 2,
    bass: ['808'], bassBase: 24, layers: [200, 900, 800, 0, 300, 0], softBuild: 1, labels: RAP,
    song: { intro: [4, 8], verse: [16], pre: [4], pPre: 0, chorus: [8, 16], post: [8], pPost: 0, bridge: [8], pBridge: 200, pPeak: 500, cyc: [2, 3], outro: [4, 8], maxBars: 112 } }),
  // DRILL: the drill snare (on 3, and late on 4), triplet-feel hats, sparse kicks, 808s that slide a lot; minor and
  // harmonic minor, dark strings, a piano or bell
  DRILL: S({ groove: 'drill', bpm: [140, 145], scales: ['minor', 'harmonic'], progs: [[0, 5], [0, 6, 5, 4], [0, 3, 5, 4], [0, 1]], chordBars: 2,
    bass: ['808slide'], bassBase: 24, layers: [100, 900, 900, 0, 200, 0], softBuild: 1, labels: RAP,
    song: { intro: [4, 8], verse: [16], pre: [4], pPre: 0, chorus: [8, 16], post: [8], pPost: 0, bridge: [8], pBridge: 200, pPeak: 500, cyc: [2, 3], outro: [4, 8], maxBars: 112 } }),
  // PHONK: Memphis: the trap groove with 16th hats all through, a cowbell melody busy and high, a distorted 808;
  // phrygian, one or two chords
  PHONK: S({ groove: 'trap', bpm: [130, 140], scales: ['phrygian', 'minor'], progs: [[0], [0, 1], [0, 5, 6, 0]], chordBars: 2,
    bass: ['808'], bassBase: 24, layers: [0, 1000, 500, 0, 200, 0], hookDens: 760, hatModes: ['16'], softBuild: 1, labels: RAP,
    song: { intro: [4, 8], verse: [8, 16], pre: [4], pPre: 0, chorus: [16], post: [8], pPost: 300, bridge: [8], pBridge: 200, pPeak: 600, cyc: [2, 3], outro: [4, 8], maxBars: 96 } }),
  // R&B: slow, sixteenth hats with their rolls, a syncopated kick, the snare and snap on 2 and 4; ninths on a Rhodes,
  // a soft sub on the root, a voice-like lead; verses, a pre-chorus, choruses, a bridge
  RNB: S({ groove: 'rnb', bpm: [66, 78], scales: ['dorian', 'minor', 'major'], progs: [[0, 3], [0, 6, 5, 4], [3, 4, 0, 0], [5, 3, 0, 4]], chordBars: 1,
    bass: ['chordsub'], swing: 120, layers: [100, 900, 1000, 300, 300, 0], pad7: 1000, softBuild: 1, labels: SONG,
    song: { intro: [4], verse: [8], pre: [4], pPre: 600, chorus: [8], post: [4], pPost: 0, bridge: [4, 8], pBridge: 700, pPeak: 600, cyc: [2, 3], outro: [4], maxBars: 64 } }),
  // LO-FI: boom bap slowed and swung harder, dusty major sevenths and ninths, a walking upright bass, a sparse lead,
  // vinyl under all of it; A and B sections
  LOFI: S({ groove: 'boom', breakDrums: 1, bpm: [72, 84], scales: ['major', 'dorian', 'minor'], progs: [[1, 4, 0, 0], [3, 2, 1, 0], [0, 5, 1, 4], [0, 3]], chordBars: 1,
    bass: ['walk'], swing: 300, layers: [0, 700, 1000, 200, 0, 0], pad7: 1000, hookDens: 300, softBuild: 1, labels: { GROOVE: 'A', BUILD: 'TURN', DROP: 'B', PEAK: 'LAST B', BREAK: 'C' },
    song: { intro: [4], verse: [8], pre: [4], pPre: 0, chorus: [8], post: [8], pPost: 0, bridge: [8], pBridge: 400, pPeak: 300, cyc: [2, 3], outro: [4], maxBars: 64 } }),
  // ---- latin & afro
  // REGGAETON: the dembow (the kick on every beat, the snare on the 4th and 7th sixteenths of each half), a tresillo
  // bass, plucked chords on the dembow, a flute or pluck hook; minor (i VI III VII)
  REGGAETON: S({ groove: 'dembow', bpm: [88, 98], scales: ['minor', 'dorian', 'phrygian'], progs: [[0, 5, 2, 6], [0, 3, 6, 5], [0, 6, 5, 6], [0, 5, 3, 4]], chordBars: 1,
    bass: ['tresillo'], layers: [300, 1000, 500, 800, 400, 0], comp: [[[3, 1], [6, 1], [11, 1], [14, 1]], [[0, 2], [3, 1], [6, 2], [11, 1], [14, 1]], [[2, 1], [6, 1], [10, 1], [14, 1]]],
    compVoice: 'triad', compAlso: 1, softBuild: 1, percLanes: ['conga', 'rim'], labels: SONG,
    song: { intro: [4, 8], verse: [16], pre: [4, 8], pPre: 500, chorus: [8, 16], post: [8], pPost: 200, bridge: [8], pBridge: 500, pPeak: 600, cyc: [2, 3], outro: [4, 8], maxBars: 96 } }),
  // AFROBEATS: a syncopated kick, the clap on the 4, rimshots, shakers in sixteenths, a son clave on the bell, congas;
  // major and dorian, a syncopated bass, marimba arpeggios, keys comping
  AFROBEATS: S({ groove: 'afro', bpm: [100, 110], scales: ['major', 'dorian', 'minor'], progs: [[0, 3, 4, 3], [5, 3, 0, 4], [1, 4, 0, 0], [0, 4, 5, 3]], chordBars: 2,
    bass: ['afro'], swing: 120, layers: [700, 900, 700, 800, 300, 0], pad7: 400, comp: [[[0, 2], [3, 1], [6, 2], [10, 1], [12, 2]], [[2, 2], [6, 1], [8, 2], [11, 1], [14, 2]], [[0, 1], [3, 2], [7, 1], [10, 2]]],
    compVoice: 'triad', compAlso: 1, softBuild: 1, percLanes: ['conga', 'rim'], labels: SONG,
    song: { intro: [4, 8], verse: [16], pre: [4], pPre: 300, chorus: [8, 16], post: [8], pPost: 300, bridge: [8], pBridge: 500, pPeak: 600, cyc: [2, 3], outro: [8], maxBars: 112 } }),
  // AMAPIANO: a light four on the floor, shakers through everything, rims off the beat, the log drum as the bass
  // (syncopated, sliding), jazzy keys in sevenths, long intros, builds that keep the groove
  AMAPIANO: S({ groove: 'piano', breakDrums: 1, bpm: [110, 115], scales: ['minor', 'dorian', 'major'], progs: [[0, 3], [0, 5, 3, 4], [1, 4, 0, 5], [0, 6, 5, 4]], chordBars: 2,
    bass: ['log'], swing: 120, layers: [300, 700, 1000, 800, 300, 0], pad7: 900, comp: [[[0, 3], [6, 2], [10, 3]], [[2, 2], [6, 2], [10, 2], [14, 2]], [[0, 2], [3, 2], [8, 3], [11, 2]]],
    compVoice: 'seventh', compAlso: 1, softBuild: 1, percLanes: ['conga', 'rim', 'clave'] }),
  // ---- pop, rock & more
  // POP: the backbeat, a root bass in eighths, a piano comping, a pad, a pluck hook; major (I V vi IV and its family)
  // or minor; intro, verses, pre-choruses, choruses, a bridge, a last chorus
  POP: S({ groove: 'back', bpm: [100, 124], scales: ['major', 'major', 'minor'], progs: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4], [3, 0, 4, 5]], chordBars: 1,
    bass: ['root8'], layers: [400, 1000, 800, 900, 500, 0], comp: [[[0, 3], [3, 3], [6, 2], [8, 3], [11, 3], [14, 2]], [[0, 4], [4, 4], [8, 4], [12, 4]], [[0, 6], [6, 2], [8, 6], [14, 2]]],
    compVoice: 'open', compBase: 60, compAlso: 1, softBuild: 1, hatModes: ['8', '16'], labels: SONG,
    song: { intro: [4, 8], verse: [8, 16], pre: [4, 8], pPre: 700, chorus: [8, 16], post: [4], pPost: 200, bridge: [8], pBridge: 800, pPeak: 900, cyc: [2, 3], outro: [4, 8], maxBars: 112 } }),
  // ROCK: kick and snare, eighths on the hats (the ride in the choruses), crashes on the downbeats, the bass on the
  // root in eighths, power chords in eighths, a lead; minor, mixolydian, major
  ROCK: S({ groove: 'rock', breakDrums: 1, bpm: [110, 140], scales: ['minor', 'mixolydian', 'major'], progs: [[0, 5, 6, 0], [0, 6, 3, 0], [0, 3, 4, 3], [0, 5, 3, 4]], chordBars: 1,
    bass: ['root8'], layers: [0, 900, 300, 1000, 300, 0], comp: [[[0, 2], [2, 2], [4, 2], [6, 2], [8, 2], [10, 2], [12, 2], [14, 2]], [[0, 3], [3, 3], [6, 2], [8, 3], [11, 3], [14, 2]], [[0, 6], [6, 2], [8, 6], [14, 2]]],
    compVoice: 'power', compBase: 48, compAlso: 1, softBuild: 1, roll: 'toml', labels: SONG,
    song: { intro: [4, 8], verse: [8, 16], pre: [4, 8], pPre: 500, chorus: [8, 16], post: [8], pPost: 200, bridge: [8], pBridge: 700, pPeak: 900, cyc: [2, 3], outro: [4, 8], maxBars: 112 } }),
  // CINEMATIC: no kit: big drums and toms on the climaxes, a cello ostinato, strings and choir, brass for the theme,
  // timpani rolls into the climaxes; minor, harmonic minor, dorian
  CINEMATIC: S({ groove: 'cine', bpm: [80, 100], scales: ['minor', 'harmonic', 'dorian'], progs: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6], [0, 5, 3, 4]], chordBars: 2,
    bass: ['ostinato'], layers: [600, 1000, 1000, 200, 800, 0], roll: 'toml', hookDens: 420,
    labels: { INTRO: 'OPENING', GROOVE: 'THEME', BUILD: 'RISE', DROP: 'CLIMAX', PEAK: 'FINALE', BREAK: 'INTERLUDE', OUTRO: 'END' } }),
  // AMBIENT: no drums, a drone on the root, long chords, a sparse piano, textures; major, lydian, dorian
  AMBIENT: S({ groove: 'none', bpm: [60, 80], scales: ['major', 'lydian', 'dorian'], progs: [[0, 3], [0, 4, 3, 0], [5, 3], [0, 1]], chordBars: 4,
    bass: ['drone'], layers: [300, 600, 1000, 0, 800, 0], hookDens: 160, pad7: 600, softBuild: 1,
    labels: { INTRO: 'DAWN', GROOVE: 'DRIFT', BUILD: 'SWELL', DROP: 'BLOOM', PEAK: 'BLOOM', BREAK: 'STILL', OUTRO: 'DUSK' } }),
};
// (Kraken's) the grooves the brain has no code for: siren/brain.js plays them through extDrums
export const EXT_GROOVES = new Set(['back', 'rock', 'boom', 'trap', 'drill', 'rnb', 'dembow', 'afro', 'piano', '2step', 'cine', 'none']);

// the forms of Kraken's dance styles (SIREN's kind: siren/brain.js form), and how they begin
const O = (...v) => v;
const F = (intro, intro2, groove1, midg, brks, brkl, build, drop, tail, outro, p) => ({ intro, intro2, groove1, midg, brks, brkl, build, drop, tail, outro,
  pIntro2: p[0], pGroove1: p[1], pMid: p[2], pBreak1: p[3], pBuild: p[4], pFake: p[5], pPause: p[6], pPeak: p[7], pPeakLast: p[8], pTail: p[9], cycLo: p[10], cycHi: p[11], maxBars: p[12] });
export const EXT_FORMS = {
  DUBSTEP: F(O(16, 32), O(8, 16), O(16), O(8), O(8), O(16, 32), O(8), O(16, 32), O(8), O(16), [300, 300, 200, 600, 1000, 100, 400, 100, 300, 300, 2, 2, 160]),
  FUTUREBASS: F(O(8, 16), O(8), O(16), O(8, 16), O(8), O(16), O(8), O(16), O(8), O(8, 16), [400, 700, 500, 700, 1000, 150, 400, 100, 400, 300, 2, 2, 144]),
  UKG: F(O(16, 32), O(16), O(32), O(16, 32), O(8), O(8, 16), O(8), O(32), O(16), O(16, 32), [500, 900, 700, 600, 600, 50, 150, 200, 300, 500, 1, 3, 192]),
  DISCO: F(O(16, 32), O(16), O(32), O(16, 32), O(8), O(8, 16), O(8), O(32, 48), O(16), O(16, 32), [500, 900, 700, 600, 500, 0, 100, 200, 300, 600, 1, 3, 176]),
  AMAPIANO: F(O(16, 32), O(16, 32), O(32, 48), O(16, 32), O(8), O(16), O(8, 16), O(32, 48), O(16), O(16, 32), [700, 900, 800, 600, 700, 0, 0, 200, 300, 600, 2, 3, 224]),
  CINEMATIC: F(O(8), O(8, 16), O(16), O(8, 16), O(8), O(8, 16), O(8), O(16), O(8), O(8, 16), [300, 1000, 600, 500, 1000, 0, 200, 200, 900, 200, 2, 2, 96]),
  AMBIENT: F(O(16), O(16), O(16, 32), O(16), O(16), O(16), O(8), O(16, 32), O(16), O(16), [300, 1000, 600, 800, 400, 0, 0, 300, 600, 300, 2, 2, 96]),
};
// how they begin (siren/brain.js IK: the drums, an atmosphere, the hook alone, filtered, the bass first, straight in,
// the breakdown first), per mille
export const EXT_INTRO_W = {
  DUBSTEP: [300, 300, 150, 100, 0, 50, 100], FUTUREBASS: [200, 250, 300, 150, 0, 50, 50], UKG: [500, 50, 150, 100, 200, 0, 0], DISCO: [600, 50, 150, 100, 100, 0, 0],
  SYNTHWAVE: [300, 300, 200, 100, 100, 0, 0], CHIPTUNE: [500, 0, 300, 0, 100, 100, 0], HIPHOP: [500, 100, 300, 0, 0, 100, 0], TRAP: [300, 200, 400, 0, 0, 100, 0],
  DRILL: [300, 200, 400, 0, 0, 100, 0], PHONK: [400, 0, 400, 100, 0, 100, 0], RNB: [400, 200, 300, 0, 0, 100, 0], LOFI: [400, 200, 300, 0, 0, 100, 0],
  REGGAETON: [400, 100, 300, 100, 0, 100, 0], AFROBEATS: [500, 100, 300, 0, 100, 0, 0], AMAPIANO: [400, 200, 100, 100, 200, 0, 0], POP: [300, 200, 300, 100, 0, 100, 0],
  ROCK: [600, 0, 200, 0, 100, 100, 0], CINEMATIC: [0, 700, 300, 0, 0, 0, 0], AMBIENT: [0, 800, 200, 0, 0, 0, 0],
};

// ------------------------------------------------------------------------------------------ a song's form ---
// intro, then verse (a pre-chorus now and then), chorus, two or three times; before the last chorus a bridge now and
// then (with its own pre-chorus), the last chorus a peak (often), the outro. siren/brain.js's sections: INTRO, GROOVE
// (a verse), BUILD (a pre-chorus), DROP (a chorus), BREAK (a bridge), PEAK (the last chorus), OUTRO
export function songForm(f, r, wts, IK) {
  const plan = [], add = (s, n) => { const l = plan[plan.length - 1]; if (l && l[0] === s) { l[1] += n; return; } if (plan.length < 40) plan.push([s, n]); };
  let ik = 0, w = r.i(1000);
  while (ik < 6 && w >= wts[ik]) w -= wts[ik++];
  if (ik === IK.BREAK) ik = IK.DRUMS;
  plan.ik = ik;
  if (ik !== IK.DIRECT) add('INTRO', r.pick(f.intro));
  const n = f.cyc[0] + r.i(f.cyc[1] - f.cyc[0] + 1);
  for (let c = 0; c < n; c++) {
    const last = c === n - 1;
    if (last && c && r.chance(f.pBridge)) { add('BREAK', r.pick(f.bridge)); if (r.chance(f.pPre)) add('BUILD', r.pick(f.pre)); }
    else { add('GROOVE', r.pick(f.verse)); if (r.chance(f.pPre)) add('BUILD', r.pick(f.pre)); }
    add(last && r.chance(f.pPeak) ? 'PEAK' : 'DROP', r.pick(f.chorus));
    if (!last && r.chance(f.pPost)) add('GROOVE', r.pick(f.post));
  }
  add('OUTRO', r.pick(f.outro));
  return plan;
}

// ----------------------------------------------------------------------------------------- the grooves ---
// a groove's pattern, drawn once a track (siren/brain.js motifs: after SIREN's own draws, from the drums' stream):
// two bars of steps (0..31) for each part
export function extDrumPattern(G, r, st) {
  const X = { kick: [], snare: [], clap: [], ghost: [], hat: 'none', hatK: 8, hatRot: 0, open: [], rolls: [], rim: [], bell: [], perc: null, shaker: false, ride: false, toms: [] };
  const pick2 = (K) => { const a = r.pick(K); return two(a, r.chance(500) ? a : r.pick(K)); };
  // rolls (the hats of trap, drill, R&B): [step, kind] on even steps
  const rolls = (spots, n, kinds) => { const out = []; for (let i = 0; i < n; i++) { const s = r.pick(spots); if (!out.some((x) => x[0] === s)) out.push([s, r.pick(kinds)]); } return out; };
  if (G === 'back') {
    X.kick = pick2([[0, 8], [0, 8, 10], [0, 6, 8], [0, 7, 8], [0, 3, 8, 10], [0, 8, 11]]); X.snare = two([4, 12]);
    if (r.chance(500)) X.clap = X.snare.slice();
    X.hat = r.pick(st.hatModes); X.open = r.chance(400) ? [30] : []; X.ghost = r.chance(300) ? [31] : [];
  } else if (G === 'rock') {
    X.kick = pick2([[0, 8], [0, 2, 8], [0, 8, 10], [0, 6, 8], [0, 8, 11]]); X.snare = two([4, 12]);
    X.hat = '8'; X.ride = r.chance(600); X.open = r.chance(500) ? [14, 30] : [];
  } else if (G === 'boom') {
    X.kick = pick2([[0, 7, 10], [0, 10, 11], [0, 3, 10], [0, 6, 10, 15], [0, 8, 10], [0, 9, 10]]); X.snare = two([4, 12]);
    X.ghost = r.pick([[], [7], [15], [7, 31], [26], [13, 29]]); X.hat = r.chance(750) ? '8' : '16'; X.open = r.chance(300) ? [30] : [];
    X.rim = r.chance(300) ? two([6], [14]) : [];
  } else if (G === 'trap') {
    X.kick = r.pick([[0, 7, 10, 16, 26], [0, 10, 14, 16, 22, 27], [0, 6, 10, 16, 19, 26], [0, 11, 16, 23, 26, 30], [0, 3, 10, 16, 24, 27]]);
    X.clap = [8, 24]; X.snare = r.chance(500) ? [8, 24] : [];
    X.hat = r.pick(st.hatModes || ['8']) === '16' ? '16' : '8';
    X.rolls = rolls([6, 10, 12, 14, 22, 26, 28, 30], 2 + r.i(3), ['16', '32', 'trip', '16', 'fast']);
    X.open = r.chance(400) ? [r.pick([14, 30])] : []; X.rim = r.chance(300) ? [r.pick([3, 11, 19, 27])] : [];
  } else if (G === 'drill') {
    X.kick = r.pick([[0, 11, 16, 27], [0, 6, 16, 22, 27], [0, 10, 16, 26], [0, 3, 11, 16, 27]]);
    X.snare = [8, 24, ...r.pick([[], [14], [30], [14, 30]])]; X.clap = [];
    X.hat = 'list'; X.hatList = two(r.pick([[0, 3, 6, 8, 11, 14], [0, 2, 5, 8, 10, 13], [0, 3, 6, 10, 12, 14]]), r.pick([[0, 3, 6, 8, 11, 14], [0, 3, 6, 10, 12, 14], [0, 2, 4, 7, 10, 13]]));
    X.rolls = rolls([4, 12, 20, 28], 1 + r.i(2), ['trip', 'trip', '32']);
  } else if (G === 'rnb') {
    X.kick = pick2([[0, 3, 10], [0, 7, 10, 13], [0, 10, 11], [0, 6, 10], [0, 3, 7, 10]]); X.snare = two([4, 12]); X.clap = X.snare.slice();
    X.ghost = r.chance(500) ? two([7], [15]) : []; X.hat = '16'; X.rolls = rolls([6, 14, 22, 30], 1 + r.i(2), ['32', '32', 'trip']);
  } else if (G === 'dembow') {
    X.kick = two([0, 4, 8, 12]); X.snare = two([3, 6, 11, 14]); X.hat = r.chance(500) ? '8' : 'off8'; X.shaker = r.chance(600);
    X.perc = { lane: 'conga', k: 5, rot: r.i(16) }; X.open = r.chance(300) ? [30] : [];
  } else if (G === 'afro') {
    X.kick = pick2([[0, 6, 10], [0, 7, 10], [0, 3, 8, 11], [0, 8, 11]]); X.clap = r.chance(500) ? two([12]) : two([4, 12]);
    const rr = r.i(16); X.rim = two([...Array(16).keys()].filter((i) => euclid(5, 16, rr, i) && i % 4));
    X.shaker = true; X.bell = two(r.pick([[0, 3, 6, 10, 12], [0, 3, 7, 10, 12], [0, 4, 7, 10, 12]])); X.perc = { lane: 'conga', k: 7, rot: r.i(16) };
  } else if (G === 'piano') {
    X.kick = pick2([[0, 4, 8, 12], [0, 4, 8, 12], [0, 8], [0, 6, 8, 12]]); X.clap = r.chance(500) ? two([12]) : two([4, 12]);
    X.rim = two(r.pick([[3, 7, 10, 14], [2, 6, 10, 14], [3, 6, 11, 14]])); X.shaker = true; X.hat = 'off8';
    X.perc = { lane: r.pick(st.percLanes), k: 5, rot: r.i(16) };
  } else if (G === '2step') {
    X.kick = pick2([[0, 10], [0, 9, 10], [0, 7, 10], [0, 10, 14], [0, 3, 10]]); X.snare = two([4, 12]);
    X.hat = 'euclid'; X.hatK = st.hats[0] + r.i(st.hats[1] - st.hats[0] + 1); X.hatRot = r.i(4); X.open = r.chance(500) ? [14, 30] : [];
    X.rim = r.chance(500) ? two([7], [15]) : []; X.shaker = r.chance(400); X.perc = { lane: r.pick(st.percLanes), k: 3 + r.i(3), rot: r.i(16) };
  } else if (G === 'cine') {
    X.kick = pick2([[0, 8], [0, 6, 8], [0, 3, 8, 11]]); const tr = r.i(16), tk = r.pick([5, 7, 3]);
    X.toms = two([...Array(16).keys()].filter((i) => euclid(tk, 16, tr, i))); X.snare = r.chance(500) ? two([12]) : [];
  }
  return X;
}

// the groove, a sixteenth (siren/brain.js step16 calls it for Kraken's grooves): what plays where in the form
export function extDrums(c) {
  const { DP, drum, st, G, sec, step, bar, barInSec, secLen, barInPhrase, e, dens, r, brk, live, lastBarOfBuild } = c;
  const X = DP.x;
  if (!X || G === 'none') return;
  const s2 = (bar % 2) * 16 + step, has = (a) => a.indexOf(s2) >= 0;
  const intro = sec === 'INTRO', build = sec === 'BUILD', soft = !!st.softBuild, outro = sec === 'OUTRO';
  const fillBar = build && lastBarOfBuild, offbeat = step % 4 === 2;
  const thin = intro && barInSec < 2;                               // (an intro's first bars: hats and percussion)
  const keep = !brk || st.breakDrums;                               // (a bridge: the hats and percussion, if the style keeps them)
  // the film score: big drums and toms only when the music climbs or peaks, a timpani roll into the climaxes
  if (G === 'cine') {
    if (live || (sec === 'GROOVE' && barInSec >= 4)) {
      if (has(X.toms)) drum(step % 8 === 0 ? 'toml' : 'tomh', (live ? 84 : 62) + div(30 * e, 1000));
      if (live && has(X.kick)) drum('kick', 112);
      if (live && has(X.snare)) drum('snare', 100);
    }
    if (live && step === 0 && (barInSec === 0 || barInPhrase === 0)) drum('crash', barInSec === 0 ? 120 : 96);
    if (build) { const every = 4 * barInSec < secLen ? 4 : 2 * barInSec < secLen ? 2 : 1; if (step % every === 0) drum('toml', 50 + div(70 * barInSec, secLen)); }
    return;
  }
  // the kick
  const kickOn = !brk && !thin && !(fillBar && step >= 8) && !(outro && 2 * barInSec >= secLen && (barInSec & 1));
  if (build && !soft) { if (!(fillBar && step >= 8) && step % (2 * barInSec < secLen ? 8 : 4) === 0) drum('kick', 110); }   // (a dance build: the kick counts in)
  else if (kickOn && has(X.kick)) drum('kick', s2 % 16 === 0 ? 122 : 110);
  if (brk && st.breakDrums && step === 0 && !(bar & 1) && G !== 'piano') drum('kick', 96);   // (a bridge: a kick to hold it)
  if (live && step === 0 && (barInSec === 0 || (barInPhrase === 0 && r.chance(500)))) drum('crash', barInSec === 0 ? 118 : 95);
  // the backbeat: snare, clap, their ghosts
  const bbOn = !brk && !(intro && barInSec < 4) && !(build && !soft) && !(fillBar && step >= 8) && e > 300;
  if (bbOn) {
    if (has(X.snare)) drum('snare', 112 + (live ? 8 : 0));
    if (has(X.clap)) drum('clap', G === 'piano' || G === 'afro' ? 96 : 108);
    if (has(X.ghost) && r.chance(500 + div(400 * dens, 1000))) drum('snare2', 45 + div(20 * e, 1000));
  }
  // the hats (the ride in a rock chorus), their rolls; the open hat
  if (e > 200 && keep && !(fillBar && step >= 12)) {
    const acc = offbeat ? 1000 : step % 2 === 0 ? 820 : 620;
    let v = 58 + div(46 * acc * (600 + div(400 * e, 1000)), 1000000); if (brk) v = div(v * 8, 10);
    const roll = X.rolls.find((x) => x[0] === s2 || x[0] + 1 === s2);
    if (X.ride && live) { if (step % 2 === 0) drum('ride', step % 4 ? 70 : 84); }
    else if (roll && (live || sec === 'GROOVE' || build)) {
      const first = roll[0] === s2, k = roll[1];
      if (k === '16') drum('hat', v);
      else if (k === '32') { drum('hat', v); drum('hat', v - 8, 3); }
      else if (k === 'trip') { if (first) { drum('hat', v); drum('hat', v - 6, 4); } else drum('hat', v - 10, 2); }
      else if (k === 'fast') { for (const o of [0, 2, 4]) drum('hat', v - (first ? 10 : 0) + o * 2, o); }
    } else {
      const m = X.hat;
      const hit = m === '16' ? true : m === '8' ? step % 2 === 0 : m === 'off8' ? offbeat : m === 'list' ? has(X.hatList) : m === 'euclid' ? euclid(div(X.hatK * (600000 + 800 * dens) + 500000, 1000000), 16, X.hatRot, step) : false;
      if (hit && (m !== '16' || dens > 200 || step % 2 === 0)) drum('hat', v);
    }
    if (has(X.open) && !brk && e > 450) drum('open', 84 + div(20 * e, 1000));
  }
  // the percussion: rims, the bell's clave, shakers, congas
  if (keep && e > 350 && !thin) {
    if (has(X.rim)) drum('rim', 80 + div(20 * e, 1000));
    if (has(X.bell) && (live || sec === 'GROOVE')) drum('clave', 84);
  }
  if (X.shaker && keep && e > 300) drum('shake', (offbeat ? 70 : step % 2 ? 50 : 60) + div(20 * e, 1000));
  if (X.perc && (e > 550 || (brk && st.breakDrums)) && euclid(X.perc.k, 16, X.perc.rot, step) && r.chance(600 + div(400 * dens, 1000))) drum(X.perc.lane, 76 + div(30 * e, 1000));
  // the fill: the last beat of a phrase now and then, the style's own
  if ((sec === 'GROOVE' || live) && barInPhrase === 7 && step >= 12 && !fillBar && c.rng(c.hash(c.seed, bar * 3 + 5)).chance(300 + div(400 * dens, 1000))) {
    if (G === 'trap' || G === 'drill') { drum('snare', 70 + 10 * (step - 12)); drum('snare', 66 + 10 * (step - 12), 3); }
    else if (G === 'back' || G === 'rock') drum(step < 14 ? 'tomh' : 'toml', 86 + 8 * (step - 12));
    else if (G === 'dembow' || G === 'afro' || G === 'piano') drum('conga', 80 + 8 * (step - 12));
    else drum(step % 2 ? 'snare2' : 'snare', 76 + 10 * (step - 12));
  }
  // the build's end: a dance build rolls (SIREN's), a song's fills its last two beats
  if (build && !soft) {
    const every = 4 * barInSec < secLen ? 4 : 2 * barInSec < secLen ? 2 : 1;
    if (step % every === 0) drum(st.roll, 60 + div(60 * barInSec, secLen));
    if (4 * barInSec >= 3 * secLen && step % 2 === 1) drum(st.roll, 70 + div(50 * barInSec, secLen));
  } else if (fillBar && step >= 8) {
    if (G === 'rock' || G === 'back') drum(step < 12 ? 'snare' : step < 14 ? 'tomh' : 'toml', 78 + 5 * (step - 8));
    else if (G === 'trap' || G === 'drill' || G === 'rnb') { drum('snare', 64 + 6 * (step - 8)); if (step >= 12) drum('snare', 60 + 6 * (step - 8), 3); }
    else if (step % (step >= 12 ? 1 : 2) === 0) drum(G === 'dembow' || G === 'afro' || G === 'piano' ? 'conga' : 'snare', 70 + 6 * (step - 8));
  }
}

// ----------------------------------------------------------------------------------------- the basses ---
// a bass's pattern (siren/brain.js motifs, from the bass's stream): steps { d: the degree from the chord's root (7
// the octave), o, len (sixteenths), v, slide }; 16 steps or 32 (two bars)
export function extBass(kind, r, drums) {
  const S = (d, o, len, v, slide = 0) => ({ d, o, len, v, slide, wob: null });
  const s = Array(16).fill(null);
  const kicks = drums?.x?.kick || [0, 8, 16, 24];
  // from the kick: each hit held to the next (an 808, a boom bap sub)
  const follow = (cap, degs, slideP) => {
    const out = Array(32).fill(null), k = [...kicks].sort((a, b) => a - b);
    k.forEach((at, i) => {
      const next = k[i + 1] ?? 32 + k[0], len = Math.max(1, Math.min(cap, next - at));
      out[at] = S(i === 0 ? 0 : r.pick(degs), 0, len, at % 16 === 0 ? 118 : 108, r.chance(slideP) ? 1 : 0);
    });
    return out;
  };
  if (kind === 'root8') {
    for (let i = 0; i < 16; i += 2) s[i] = S(0, 0, 2, i % 4 ? 90 : 104);
    if (r.chance(500)) s[14] = S(r.pick([4, 7, 6, 2]), 0, 2, 94);
    if (r.chance(300)) { s[6] = S(0, 0, 1, 90); s[7] = S(0, 0, 1, 82); }
    return s;
  }
  if (kind === 'octave') { for (let i = 0; i < 16; i += 2) s[i] = S((i >> 1) % 2 ? 7 : 0, 0, 1, (i >> 1) % 2 ? 96 : 108); if (r.chance(500)) s[15] = S(r.pick([6, 4, 5]), 0, 1, 84); if (r.chance(400)) s[11] = S(7, 0, 1, 80); return s; }
  if (kind === 'synth8') { const sixteen = r.chance(600); for (let i = 0; i < 16; i += sixteen ? 1 : 2) s[i] = S(i === 14 && r.chance(300) ? 7 : 0, 0, 1, i % 4 === 0 ? 110 : i % 2 ? 80 : 95); return s; }
  if (kind === 'walk') {
    const P = r.pick([[0, 2, 4, 5], [0, 4, 5, 6], [0, 0, 4, 6], [0, 2, 3, 4], [0, 4, 2, 6]]);
    for (let q = 0; q < 4; q++) { s[4 * q] = S(P[q], 0, 3, q ? 92 : 104); if (q < 3 && r.chance(250)) s[4 * q + 3] = S(P[q + 1] - 1, 0, 1, 76); }
    return s;
  }
  if (kind === 'kick') return follow(6, [0, 0, 0, 4], 0);
  if (kind === '808') return follow(12, [0, 0, 0, 4, 7, 5, 6], 250);
  if (kind === '808slide') return follow(12, [0, 0, 7, 4, 5, 6, 3, 2], 600);
  if (kind === 'tresillo') { const D = r.pick([[0, 0, 0, 0, 0, 4], [0, 0, 4, 0, 0, 7], [0, 0, 0, 5, 5, 4]]); [0, 3, 6, 8, 11, 14].forEach((at, i) => { s[at] = S(D[i], 0, at % 8 === 6 ? 2 : 3, at % 8 === 0 ? 112 : 100); }); return s; }
  if (kind === 'afro') { const H = r.pick([[0, 3, 6, 10, 13], [0, 6, 8, 11, 14], [0, 3, 8, 10, 14]]); for (const at of H) s[at] = S(at ? r.pick([0, 0, 4, 2, 7]) : 0, 0, 2, at ? 98 : 112); return s; }
  if (kind === 'log' || kind === 'garage') {
    const out = Array(32).fill(null);
    const H = kind === 'log' ? [[0, 3, 6, 10, 13], [2, 5, 8, 11, 14], [0, 3, 7, 10, 12, 14], [0, 6, 10, 13]] : [[0, 3, 6, 10, 13], [0, 6, 10, 14], [0, 3, 10, 13], [0, 7, 10]];
    for (let b = 0; b < 2; b++) for (const at of r.pick(H)) {
      const d = at || b ? r.pick(kind === 'log' ? [0, 0, 4, 7, 5, 2, 9] : [0, 0, 0, 7, 4]) : 0;
      out[16 * b + at] = S(d, 0, r.pick(kind === 'log' ? [1, 2, 3] : [1, 2, 2, 3]), 96 + r.i(25), kind === 'log' && r.chance(300) ? 1 : 0);
    }
    return out;
  }
  if (kind === 'chordsub') { for (const [at, len] of r.pick([[[0, 6], [8, 6]], [[0, 10], [10, 6]], [[0, 3], [3, 3], [8, 8]], [[0, 14]]])) s[at] = S(0, 0, len, at ? 96 : 110); return s; }
  if (kind === 'drone') { s[0] = S(0, 0, 16, 88); return s; }
  if (kind === 'ostinato') { const P = r.pick([[0, 0, 4, 0], [0, 4, 7, 4], [0, 0, 7, 4], [0, 2, 4, 2]]); for (let i = 0; i < 8; i++) s[2 * i] = S(P[i % 4], 0, 2, i % 2 ? 84 : 100); return s; }
  if (kind === 'chip') { const P = r.pick([[0, 7], [0, 0, 7, 4], [0, 7, 4, 7]]); for (let i = 0; i < 16; i++) s[i] = S(P[i % P.length], 0, 1, i % 4 === 0 ? 108 : 88); return s; }
  for (const i of [2, 6, 10, 14]) s[i] = S(0, 0, 1, 100);          // (anything else: SIREN's offbeat bass)
  return s;
}
