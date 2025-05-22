import { nanoid } from "nanoid";

function rand(max: number = 256): number {
  return Math.floor(Math.random() * max);
}

// Generate a random RGB color string
function randomColor(alpha: number = 1): string {
  const r = rand();
  const g = rand();
  const b = rand();
  return `rgba(${r},${g},${b},${alpha})`;
}

// 1. Gradient Avatar (multi-stop radial + linear)
export function gradientAvatarSVG(size: number = 256): string {
  const stops = Array.from({ length: 3 }, () => randomColor());
  const angle = rand(360);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <radialGradient id="rgrad" fx="50%" fy="50%">
      ${stops.map((c, i) => `<stop offset="${(i/(stops.length-1))*100}%" stop-color="${c}"/>`).join("\n      ")}
    </radialGradient>
    <linearGradient id="lgrad" gradientTransform="rotate(${angle})">
      ${stops.reverse().map((c, i) => `<stop offset="${(i/(stops.length-1))*100}%" stop-color="${c}"/>`).join("\n      ")}
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#rgrad)"/>
  <rect width="${size}" height="${size}" fill="url(#lgrad)" opacity="0.5"/>
</svg>
`;
}

// 2. Geometric Avatar (triangles and circles)
export function geometricAvatarSVG(size: number = 256): string {
  const shapes: string[] = [];
  for (let i = 0; i < 7; i++) {
    const x = rand(size);
    const y = rand(size);
    const s = rand(size / 3) + 20;
    if (i % 2 === 0) {
      shapes.push(
        `<polygon points="${x},${y} ${x+s},${y} ${x + s/2},${y + s}" fill="${randomColor()}"/>`
      );
    } else {
      shapes.push(
        `<circle cx="${x}" cy="${y}" r="${s/2}" fill="${randomColor()}"/>`
      );
    }
  }
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  ${shapes.join("\n  ")}
</svg>
`;
}

// 3. Line Art Avatar (random bezier scribbles)
export function lineArtAvatarSVG(size: number = 256): string {
  const paths: string[] = [];
  for (let i = 0; i < 5; i++) {
    const path = [];
    const steps = 6;
    for (let j = 0; j < steps; j++) {
      const x = rand(size);
      const y = rand(size);
      path.push(`${x},${y}`);
    }
    paths.push(
      `<path d="M${path.join(" L")}" stroke="${randomColor()}" stroke-width="2" fill="none" stroke-linecap="round"/>`
    );
  }
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  ${paths.join("\n  ")}
</svg>
`;
}

// 4. Watercolor Avatar (opaque circles with blur)
export function watercolorAvatarSVG(size: number = 256): string {
  const circles: string[] = [];
  for (let i = 0; i < 8; i++) {
    const x = rand(size);
    const y = rand(size);
    const r = rand(size / 4) + 10;
    circles.push(
      `<circle cx="${x}" cy="${y}" r="${r}" fill="${randomColor(0.4)}" filter="url(#blur)"/>`
    );
  }
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <filter id="blur"><feGaussianBlur stdDeviation="8"/></filter>
  </defs>
  ${circles.join("\n  ")}
</svg>
`;
}

// 5. Pixel Avatar (grid of colored squares)
export function pixelAvatarSVG(size: number = 256, grid=8): string {
  const cell = size / grid;
  const rects: string[] = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      rects.push(
        `<rect x="${i*cell}" y="${j*cell}" width="${cell}" height="${cell}" fill="${randomColor()}"/>`
      );
    }
  }
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  ${rects.join("\n  ")}
</svg>
`;
}

// 6. Ornament Avatar (radial repeating pattern)
export function ornamentAvatarSVG(size: number = 256): string {
  const patternSize = 32;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <pattern id="pat" width="${patternSize}" height="${patternSize}" patternUnits="userSpaceOnUse">
      <circle cx="${patternSize/2}" cy="${patternSize/2}" r="${patternSize/4}" fill="${randomColor()}"/>
    </pattern>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#pat)"/>
</svg>
`;
}

// 7. Biomorphic Avatar (smooth blobs)
export function biomorphicAvatarSVG(size: number = 256): string {
  const pathData = [];
  const count = 4;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 / count) * i;
    const r = size/4 + rand(size/8);
    const x = size/2 + Math.cos(angle) * r;
    const y = size/2 + Math.sin(angle) * r;
    pathData.push(`${x},${y}`);
  }
  const d = `M${pathData.join(" L")} Z`;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <path d="${d}" fill="${randomColor()}" stroke="none"/>
</svg>
`;
}

// 8. Cosmic Avatar (stars and nebula)
export function cosmicAvatarSVG(size: number = 256): string {
  const stars: string[] = [];
  for (let i = 0; i < 30; i++) {
    const x = rand(size);
    const y = rand(size);
    const r = rand(2) + 1;
    stars.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${randomColor()}"/>`);
  }
  const nebula = gradientAvatarSVG(size);
  return nebula.replace("</svg>", `${stars.join("\n  ")}</svg>`);
}

// 9. Doodle Avatar (random bezier doodles)
export function doodleAvatarSVG(size: number = 256): string {
  const doodles: string[] = [];
  for (let i = 0; i < 4; i++) {
    const sx = rand(size);
    const sy = rand(size);
    const cx = rand(size);
    const cy = rand(size);
    const ex = rand(size);
    const ey = rand(size);
    doodles.push(
      `<path d="M${sx},${sy} Q${cx},${cy} ${ex},${ey}" stroke="${randomColor()}" stroke-width="3" fill="none"/>`
    );
  }
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  ${doodles.join("\n  ")}
</svg>
`;
}

// 10. Stripe Avatar (randomized stripes)
export function stripeAvatarSVG(size: number = 256, stripes=8): string {
  const width = size / stripes;
  const rects = [];
  for (let i = 0; i < stripes; i++) {
    rects.push(
      `<rect x="${i*width}" y="0" width="${width}" height="${size}" fill="${randomColor()}"/>`
    );
  }
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  ${rects.join("\n  ")}
</svg>
`;
}

export const generators = [
  { name: 'gradient', fn: gradientAvatarSVG },
  { name: 'geometric', fn: geometricAvatarSVG },
  { name: 'lineArt', fn: lineArtAvatarSVG },
  { name: 'watercolor', fn: watercolorAvatarSVG },
  { name: 'pixel', fn: pixelAvatarSVG },
  { name: 'ornament', fn: ornamentAvatarSVG },
  { name: 'biomorphic', fn: biomorphicAvatarSVG },
  { name: 'cosmic', fn: cosmicAvatarSVG },
  { name: 'doodle', fn: doodleAvatarSVG },
  { name: 'stripe', fn: stripeAvatarSVG },
] as const;

export type GeneratorName = typeof generators[number]['name'];

export function generateCover(
  name?: GeneratorName,
  size: number = 256
): { id: string; name: GeneratorName; svg: string } {
  const gen = name
    ? generators.find((g) => g.name === name)!  
    : generators[Math.floor(Math.random() * generators.length)];
  const svg = gen.fn(size);
  return { id: nanoid(), name: gen.name, svg };
}

export function testCovers(
  size: number = 256
): { name: GeneratorName; id: string; svg: string }[] {
  return generators.map((g) => {
    const { id, svg } = generateCover(g.name, size);
    return { name: g.name, id, svg };
  });
}
//TODO make this work normali (find generators that work well)