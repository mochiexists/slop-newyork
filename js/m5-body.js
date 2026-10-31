import { BODY_SPECS } from './cars.js';

// BMW M5 (G90) super saloon, the player's car in swimming mode: 5.1 m long, 1.97 m wide, a long hood and a low
// fast roof over 21" wheels, flared box arches, slim LED lamps, black twin-kidney grille (spec.kidney: the kidneys'
// centres either side of the car's centre line) and a metallic paint.
// Kept out of cars.js so the upstream file stays as it is: importing this module registers it as BODY_SPECS.m5
// (swim-car.js does, at load), for the code that reads it from there. cars.js's lofted material reads the two fields
// no upstream car has: `kidney` and `metallic`.
const M5_BODY = {
  name: 'm5',
  zFront: 2.52,
  zRear: -2.58,
  wheelRadius: 0.37,
  wheelZ: 1.5,
  wheelX: 0.835,
  archGap: 0.03,
  archFlare: 0.05,
  tuck: 0.075,
  halfWidth: [[2.52, 0.93], [1.5, 0.985], [0.2, 0.968], [-1.5, 0.99], [-2.58, 0.948]],
  sill: [[2.52, 0.235], [1.3, 0.212], [-1.3, 0.212], [-2.58, 0.27]],
  shoulder: [[2.52, 0.64], [1.95, 0.725], [1.5, 0.742], [0, 0.752], [-1.5, 0.772], [-2.58, 0.752]],
  edge: [[2.36, 0.79], [1.76, 0.85], [0.9, 0.925], [0.3, 0.948], [-0.45, 0.962], [-1.35, 0.978], [-1.8, 0.974], [-2.12, 0.952], [-2.42, 0.928]],
  crown: [[2.38, 0.042], [1.05, 0.036], [0.72, 0.004], [-1.92, 0.004], [-2.2, 0.018], [-2.58, 0.014]],
  tumble: [[2.52, 0.12], [1.0, 0.1], [-1.8, 0.1], [-2.58, 0.115]],
  nose: { halfWidth: [0.34, 0.7, 2.8], edge: [0.15, 0.72, 2.6], crown: [0.15, 0.012, 2], sill: [0.17, 0.3, 2], shoulder: [0.24, 0.6, 2.6] },
  tail: { halfWidth: [0.32, 0.74, 2.8], edge: [0.1, 0.9, 3], crown: [0.1, 0.008, 2], sill: [0.17, 0.35, 2], shoulder: [0.24, 0.69, 2.6] },
  noseRake: { length: 0.6, y: [[0.24, 0.05], [0.34, 0], [0.52, 0], [0.66, 0.03], [0.76, 0.1], [0.84, 0.14]], plan: 0.09 },
  tailRake: { length: 0.44, y: [[0.27, 0.07], [0.44, 0], [0.56, 0], [0.62, 0.012], [0.76, 0.016], [0.92, 0.03]], plan: 0.07 },
  cabin: {
    cowl: 0.74,
    roofFront: -0.16,
    roofRear: -1.3,
    deck: -2.14,
    roofY: [[-0.16, 1.39], [-0.72, 1.425], [-1.3, 1.38]],
    rail: [0.64, 0.6],
    inset: 0.03,
    bulge: 0.016,
    roofEdge: 0.05,
    roofCrown: 0.035,
    roofRound: 4,
    pillars: [-0.52],
    glassEnd: -1.86
  },
  doors: [0.8, -0.52, -1.2],
  handles: [-0.34, -1.06],
  headlight: [0.67, 0.66, 0.23, 0.036],
  taillight: [0.56, 0.8, 0.31, 0.042],
  grille: [0.6, 0.17, 0.088],
  kidney: 0.2,
  intake: [0.34, 0.62, 0.075],
  plates: [0.43, 0.66],
  bumperLine: [0.72, 0.55],
  bumpers: [[0.41, 0.03], [0.46, 0.03]],
  chrome: false,
  metallic: true,
  cladding: 0,
  sign: false,
  rails: false,
  rearWiper: false
};
// (as cars.js derives them for its own specs)
M5_BODY.lamps = [M5_BODY.headlight[1], M5_BODY.taillight[1]];
M5_BODY.lampX = [M5_BODY.headlight[0], M5_BODY.taillight[0]];

BODY_SPECS.m5 = M5_BODY;

export { M5_BODY };
