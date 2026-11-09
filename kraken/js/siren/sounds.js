// SPDX-License-Identifier: GPL-3.0-only
// The sounds of Kraken's styles for SIREN's songs (siren/song.js), as SIREN's own selection is for its eight
// (siren/data.js): for each layer the sounds a song may pick (Clipper's and SLOOP's, by engine and preset), the
// style's drum kits (SLOOP's sampled kits), the sub under its bass, and what a layer or the drums go through.
//   sounds   { LAYER: ['ENGINE:PRESET', …] }: the brain picks one a layer, by its own stream
//   kits     the sampled kits, by name
//   sub      the sub's sound (styles with a sub)
//   fx       { LAYER: [[device, params]] }; drumFx the same for the drums; drumSends [reverb, delay]
//   under    [sound, name, dB]: a sound under the whole song (lo-fi's vinyl)
//   layerDb  { LAYER: dB } a layer's place in this style's mix, against SIREN's
export const EXT_SOUNDS = {
  DUBSTEP: {
    kits: ['DUBSTEP'], sub: 'ANALOG:SUB BASS',
    sounds: { BASS: ['ANALOG:WOBBLE', 'HYBRID:WOBBLE', 'WAVE:FM GROWL', 'FMX:TRUE FM GRWL', 'FMX:FM WOBBLE', 'VPS:WOBBLE VPS', 'HYBRID:FOLD BASS', 'WAVE:SYNC SCREAM'],
      ARP: ['HYBRID:PLUCK', 'DIGITAL:FM PLUCK'], HOOK: ['HYBRID:SPACE BEL', 'DIGITAL:GLOCKEN', 'HYBRID:BRIGHT BEL', 'FMX:FMX BELL'],
      PAD: ['HYBRID:DARK PAD', 'ANALOG:DARK STR', 'GRAIN:DARK DRONE'], STAB: ['TRIO:DUB CHORD', 'TRIO:MIN STAB'], FX: ['NOISE:RISER', 'HYBRID:RISER', 'NOISE:WHOOSH'] },
    fx: { BASS: [['eq', { hp: 90 }], ['sat', { dr: 10, ty: 1, mx: 0.7, ou: -6 }]] },
  },
  FUTUREBASS: {
    kits: ['TRAP', 'HYPER'], sub: 'HYBRID:808 SUB',
    sounds: { BASS: ['ANALOG:SUB BASS', 'HYBRID:808 SUB', 'JUNO:SUB BASS 106'], ARP: ['HYBRID:SAW PLUCK', 'JUNO:ARP PLUCK', 'HYBRID:PLUCK', 'VPS:VOX PLUCK'],
      HOOK: ['MACRO:VOWELS', 'VPS:VPS LEAD', 'VOICE:AAH LEAD', 'HYBRID:SOFT SYNC', 'MACRO:YEAH'], PAD: ['JUNO:DREAM PAD', 'HYBRID:POLY PAD', 'ANALOG:WARM PAD'],
      STAB: ['ANALOG:SUPERSAW', 'WAVE:WT SUPER', 'ANALOG:UNI STAB', 'HYBRID:CLIP WIDE'], FX: ['NOISE:RISER', 'JUNO:NOISE SWEEP'] },
    fx: { STAB: [['eq', { hp: 180 }], ['chorus', { mx: 0.25 }]] },
  },
  UKG: {
    kits: ['GARAGE'],
    sounds: { BASS: ['VOICE:WOW BASS', 'MACRO:WOW BASS', 'ANALOG:SUB BASS', 'HYBRID:808 SUB', 'MACRO:TALK BASS'], ARP: ['DIGITAL:FM PLUCK', 'DIGITAL:SYN VIBES'],
      HOOK: ['VOICE:SOUL OOH', 'MACRO:VOWELS', 'VPS:VOX PLUCK', 'DIGITAL:SYN VIBES'], PAD: ['MACRO:M9 PAD', 'ANALOG:WARM PAD'],
      STAB: ['WHEEL:HOUSE ORGN', 'MACRO:HOUSE CHRD', 'TRIO:MIN7 STAB', 'MACRO:CHORD STAB'], FX: ['NOISE:WHOOSH', 'NOISE:RISER'] },
  },
  DISCO: {
    kits: ['DISCO'],
    sounds: { BASS: ['ANALOG:FUNK BASS', 'DIGITAL:BASS GTR', 'PHYS:PLUCK BASS', 'JUNO:JUNO BASS'], ARP: ['DIGITAL:CLAV', 'PHYS:MUTED GTR'],
      HOOK: ['STRINGS:VIOLINS', 'ANALOG:SYN BRASS', 'FM6:BRASS SECT', 'JUNO:SYNTH BRASS 2'], PAD: ['STRINGS:SOLINA', 'STRINGS:STR MACHINE'],
      STAB: ['STRINGS:STR STAB', 'DIGITAL:CLAV', 'SAMPLE:HORN STAB', 'SAMPLE:STRING STB'], FX: ['NOISE:WHOOSH'] },
    fx: { ARP: [['phaser', { ra: 0.4, mx: 0.3 }]] },
  },
  SYNTHWAVE: {
    kits: ['SYNTHWV', '80S'],
    sounds: { BASS: ['JUNO:JUNO BASS', 'ANALOG:MINI BASS', 'ANALOG:SAW BASS'], ARP: ['JUNO:ARP PLUCK', 'ANALOG:SQR PLUCK', 'TRIO:80S POLY'],
      HOOK: ['JUNO:SYNTHWAVE LD', 'JUNO:SAW LEAD 106', 'ANALOG:PROPH LEAD', 'ANALOG:PWM LEAD'], PAD: ['JUNO:JUNO 106 PAD', 'ANALOG:JUNO PAD', 'STRINGS:80S STR', 'JUNO:DREAM PAD'],
      STAB: ['JUNO:80S HITS', 'ANALOG:OBX BRASS'], FX: ['JUNO:NOISE SWEEP', 'NOISE:WHOOSH'] },
    fx: { HOOK: [['chorus', { mx: 0.3 }], ['delay', { ti: 4, fb: 0.35, mx: 0.18 }]], PAD: [['chorus', { mx: 0.35 }]] }, drumSends: [0.22, 0],
  },
  CHIPTUNE: {
    kits: ['CHIP', 'ARCADE'],
    sounds: { BASS: ['LOFI:NES BASS', 'LOFI:GB BASS', 'TRIO:C64 BASS', 'WAVE:CHIP BASS'], ARP: ['LOFI:8BIT ARP', 'LOFI:CHIP ARP', 'WSEQ:8BIT SEQ'],
      HOOK: ['LOFI:NES LEAD', 'LOFI:GAME LEAD', 'TRIO:SID LEAD', 'LOFI:WAVE LEAD', 'HYBRID:CHIP LEAD'], PAD: ['LOFI:GB PAD', 'LOFI:CHIP CHORD'],
      STAB: ['LOFI:CHIP CHORD'], FX: ['LOFI:ZAP', 'NOISE:NZ ARCADE'] },
    drumSends: [0.03, 0],
  },
  HIPHOP: {
    kits: ['BOOMBAP', 'DUST', 'VINTAGE'],
    sounds: { BASS: ['SAMPLE:UP BASS', 'SAMPLE:DEEP BASS', 'ANALOG:SUB BASS', 'DIGITAL:BASS GTR'], ARP: ['DIGITAL:MARIMBA', 'DIGITAL:SYN VIBES'],
      HOOK: ['SAMPLE:LOFI FLUTE', 'SAMPLE:VIBES', 'DIGITAL:MUSIC BOX', 'WHEEL:SOFT FLUTE', 'SAMPLE:HORN STAB'],
      PAD: ['DIGITAL:RHODES', 'FM6:TINE EP', 'DIGITAL:WURLI', 'SAMPLE:DUSTY PNO', 'FMX:FMX EP'], STAB: ['SAMPLE:HORN STAB', 'SAMPLE:STRING STB'], FX: ['NOISE:VINYL', 'NOISE:WHOOSH'] },
    fx: { PAD: [['eq', { hp: 120, lp: 9000 }], ['chorus', { mx: 0.22 }]] }, drumFx: [['sat', { dr: 4, mx: 0.4 }]], drumSends: [0.06, 0],
  },
  TRAP: {
    kits: ['TRAP', '808'],
    sounds: { BASS: ['ANALOG:808 BOOM', 'ANALOG:808 DIRTY', 'ANALOG:808 SLIDE', 'HYBRID:808 SUB'], ARP: ['ANALOG:TRAP PLUCK', 'DIGITAL:PLUGG BELL'],
      HOOK: ['DIGITAL:TRAP BELL', 'DIGITAL:PLUGG BELL', 'DIGITAL:MUSIC BOX', 'ANALOG:TRAP PLUCK', 'DIGITAL:FM GRAND'],
      PAD: ['HYBRID:DARK PAD', 'ANALOG:DARK STR', 'VOICE:CHOIR AAH', 'STRINGS:DARK ENS'], FX: ['NOISE:WHOOSH', 'HYBRID:RISER'] },
    fx: { BASS: [['sat', { dr: 5, mx: 0.5 }]], HOOK: [['delay', { ti: 4, fb: 0.3, mx: 0.15 }]] }, drumSends: [0.04, 0],
  },
  DRILL: {
    kits: ['DRILL'],
    sounds: { BASS: ['ANALOG:808 SLIDE', 'ANALOG:808 DIRTY', 'ANALOG:808 BOOM'], ARP: ['DIGITAL:FM PLUCK'],
      HOOK: ['DIGITAL:FM GRAND', 'SAMPLE:GRAND PNO', 'DIGITAL:TRAP BELL', 'DIGITAL:CELESTA'], PAD: ['STRINGS:DARK ENS', 'STRINGS:CELLOS', 'ANALOG:DARK STR', 'VOICE:MALE CHOIR'], FX: ['NOISE:WHOOSH'] },
    fx: { BASS: [['sat', { dr: 6, mx: 0.5 }]] }, drumSends: [0.04, 0],
  },
  PHONK: {
    kits: ['PHONK'],
    sounds: { BASS: ['ANALOG:808 DIRTY', 'ANALOG:808 BOOM'], HOOK: ['TRIO:RING BELL', 'FMX:RING BELLS', 'HYBRID:METAL', 'DIGITAL:STEEL DRUM'],
      PAD: ['VOICE:CHOIR AAH', 'HYBRID:DARK PAD'], FX: ['NOISE:RADIO', 'NOISE:WHOOSH'] },
    fx: { BASS: [['sat', { dr: 14, ty: 3, mx: 0.6, ou: -8 }]], HOOK: [['eq', { hp: 300 }]] }, drumFx: [['sat', { dr: 6, mx: 0.5 }]], drumSends: [0.03, 0],
  },
  RNB: {
    kits: ['808', 'DEEP', 'TRAP'],
    sounds: { BASS: ['ANALOG:SUB BASS', 'HYBRID:808 SUB', 'ANALOG:808 BOOM'], ARP: ['DIGITAL:HARP', 'DIGITAL:SYN VIBES'],
      HOOK: ['VOICE:SOUL OOH', 'VOICE:TALKBOX', 'MACRO:VOWELS', 'DIGITAL:SYN VIBES'], PAD: ['DIGITAL:RHODES', 'FM6:TINE EP', 'MACRO:M9 PAD', 'PHASE:CZ EPIANO', 'DIGITAL:DX RHODES'],
      STAB: ['MACRO:MAJ7 KEYS', 'DIGITAL:RHODES'], FX: ['NOISE:WHOOSH'] },
    fx: { PAD: [['chorus', { mx: 0.25 }]], HOOK: [['delay', { ti: 5, fb: 0.3, mx: 0.15 }]] }, drumSends: [0.1, 0],
  },
  LOFI: {
    kits: ['LO-FI', 'DUST'], under: ['NOISE:VINYL', 'VINYL', -12],
    sounds: { BASS: ['SAMPLE:UP BASS', 'PHYS:PLUCK BASS', 'DIGITAL:BASS GTR'], ARP: ['DIGITAL:KALIMBA'],
      HOOK: ['SAMPLE:LOFI FLUTE', 'SAMPLE:VIBES', 'DIGITAL:MUSIC BOX', 'DIGITAL:KALIMBA', 'PHYS:NYLON GTR'],
      PAD: ['SAMPLE:DUSTY PNO', 'SAMPLE:LOFI KEYS', 'DIGITAL:RHODES', 'DIGITAL:WURLI'], STAB: ['SAMPLE:LOFI KEYS'], FX: ['NOISE:VINYL'] },
    fx: { PAD: [['eq', { hp: 150, lp: 7000 }], ['chorus', { ra: 0.3, de: 0.3, mx: 0.3 }]], HOOK: [['eq', { lp: 7500 }]] },
    drumFx: [['crush', { bi: 12, ds: 2, mx: 0.5 }], ['eq', { lp: 9000 }]], drumSends: [0.1, 0],
  },
  REGGAETON: {
    kits: ['DEMBOW', 'LATIN'],
    sounds: { BASS: ['ANALOG:SUB BASS', 'HYBRID:808 SUB', 'ANALOG:808 BOOM'], ARP: ['DIGITAL:MARIMBA'],
      HOOK: ['ANALOG:PAN FLUTE', 'HYBRID:PLUCK', 'DIGITAL:FM PLUCK', 'PHYS:NYLON GTR'], PAD: ['ANALOG:WARM PAD', 'HYBRID:POLY PAD'],
      STAB: ['HYBRID:PLUCK', 'ANALOG:TRAP PLUCK', 'DIGITAL:FM PLUCK', 'PHYS:NYLON GTR'], FX: ['NOISE:WHOOSH'] },
    fx: { STAB: [['eq', { hp: 200 }]], HOOK: [['delay', { ti: 4, fb: 0.3, mx: 0.15 }]] }, drumSends: [0.05, 0],
  },
  AFROBEATS: {
    kits: ['AFRO'],
    sounds: { BASS: ['DIGITAL:BASS GTR', 'ANALOG:SUB BASS', 'PHYS:PLUCK BASS'], ARP: ['DIGITAL:MARIMBA', 'DIGITAL:KALIMBA', 'PHYS:STEEL PAN', 'PHYS:MBIRA'],
      HOOK: ['ANALOG:PAN FLUTE', 'DIGITAL:STEEL DRUM', 'PHYS:NYLON GTR', 'VOICE:SOUL OOH'], PAD: ['ANALOG:WARM PAD', 'MACRO:SUS PAD'],
      STAB: ['DIGITAL:AFRO KEYS', 'DIGITAL:RHODES', 'PHYS:MUTED GTR', 'MACRO:6/9 KEYS'], FX: ['NOISE:WHOOSH'] },
    fx: { STAB: [['eq', { hp: 180 }]] }, drumSends: [0.06, 0],
  },
  AMAPIANO: {
    kits: ['AMAPIANO'],
    sounds: { BASS: ['ANALOG:808 BOOM', 'ANALOG:PLUGG BASS', 'HYBRID:808 SUB'], ARP: ['DIGITAL:MARIMBA'],
      HOOK: ['DIGITAL:SYN VIBES', 'VOICE:SOUL OOH', 'WHEEL:SOFT FLUTE', 'ANALOG:PAN FLUTE'], PAD: ['MACRO:M9 PAD', 'ANALOG:WARM PAD', 'MACRO:SUS PAD'],
      STAB: ['DIGITAL:RHODES', 'DIGITAL:AFRO KEYS', 'MACRO:MAJ7 KEYS', 'FM6:TINE EP', 'WHEEL:JAZZ ORGAN'], FX: ['NOISE:WHOOSH'] },
    fx: { BASS: [['sat', { dr: 6, mx: 0.4 }]] }, drumSends: [0.08, 0],
  },
  POP: {
    kits: ['TIGHT', 'BRIGHT'],
    sounds: { BASS: ['JUNO:JUNO BASS', 'DIGITAL:BASS GTR', 'ANALOG:MONO BASS'], ARP: ['HYBRID:PLUCK', 'JUNO:ARP PLUCK'],
      HOOK: ['HYBRID:PLUCK', 'DIGITAL:FM PLUCK', 'ANALOG:SQR PLUCK', 'MACRO:VOWELS'], PAD: ['JUNO:DREAM PAD', 'ANALOG:WARM PAD', 'STRINGS:SLOW STR'],
      STAB: ['SAMPLE:GRAND PNO', 'DIGITAL:M1 PIANO', 'DIGITAL:FM GRAND', 'JUNO:JUNO PIANO'], FX: ['NOISE:WHOOSH', 'HYBRID:RISER'] },
    fx: { STAB: [['eq', { hp: 140 }], ['comp', { th: -22, ra: 3 }]] }, drumSends: [0.07, 0],
  },
  ROCK: {
    kits: ['ACOUSTIC'],
    sounds: { BASS: ['DIGITAL:BASS GTR', 'PHYS:PLUCK BASS', 'ANALOG:MONO BASS'], HOOK: ['PHYS:STEEL GTR', 'ANALOG:FAT LEAD', 'HYBRID:SYNC LEAD'],
      PAD: ['WHEEL:ROCK ORGAN', 'STRINGS:ENSEMBLE'], STAB: ['PHYS:STEEL GTR', 'PHYS:MUTED GTR'], FX: ['NOISE:WHOOSH'] },
    fx: { STAB: [['amp', { mo: 1, ga: 8, ba: 6, mi: 6, tr: 6, pr: 6, ca: 3 }]], HOOK: [['amp', { mo: 2, ga: 7, ca: 3 }], ['delay', { ti: 5, fb: 0.3, mx: 0.15 }]], BASS: [['amp', { mo: 4, ga: 4, ca: 4 }]] },
    drumSends: [0.12, 0],
  },
  CINEMATIC: {
    kits: ['TRIBAL', 'ACOUSTIC'],
    sounds: { BASS: ['STRINGS:CELLOS', 'PHYS:CELLO BOW', 'STRINGS:LOW STR'], ARP: ['STRINGS:VIOLINS', 'PHYS:VIOLIN BOW', 'DIGITAL:HARP'],
      HOOK: ['FM6:BRASS SECT', 'ANALOG:SYN BRASS', 'VECTOR:VS BRASS', 'FMX:FMX BRASS'], PAD: ['STRINGS:SLOW STR', 'SAMPLE:SAMPLE CHOIR', 'VOICE:CHOIR AAH', 'STRINGS:CHOIR STR', 'VOICE:MALE CHOIR'],
      STAB: ['STRINGS:STR STAB'], FX: ['HYBRID:RISER', 'NOISE:WIND'] },
    fx: { PAD: [['space', { si: 0.9, dc: 5, mx: 0.3 }]] }, drumSends: [0.3, 0],
  },
  AMBIENT: {
    kits: ['AMBIENT'],
    sounds: { BASS: ['HYBRID:DRONE', 'GRAIN:DARK DRONE', 'ANALOG:SINE PAD'], ARP: ['DIGITAL:CELESTA', 'PHYS:GLASS BOWL', 'DIGITAL:MUSIC BOX'],
      HOOK: ['SAMPLE:GRAND PNO', 'DIGITAL:FM GRAND', 'PHYS:THUMB PNO', 'DIGITAL:CELESTA'], PAD: ['GRAIN:FROZEN PAD', 'GRAIN:ANGEL HALO', 'GRAIN:CRYSTAL SWELL', 'ANALOG:ATMOS PAD', 'HYBRID:GLASS PAD'],
      FX: ['NOISE:WIND', 'NOISE:OCEAN', 'NOISE:RAIN'] },
    fx: { PAD: [['space', { si: 1, dc: 12, da: 0.6, pr: 0.06, mo: 0.9, lc: 200, mx: 0.45 }]], HOOK: [['delay', { ti: 6, fb: 0.45, to: 0.4, mx: 0.25 }]] },
    layerDb: { BASS: 7, ARP: 6, HOOK: 7, PAD: 7, FX: 5 },
  },
};
