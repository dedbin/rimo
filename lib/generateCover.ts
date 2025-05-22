import { nanoid } from "nanoid";

export function gradientAvatarSVG(size = 256): string {
  const stop1 = `rgb(${rand()},${rand()},${rand()})`;
  const stop2 = `rgb(${rand()},${rand()},${rand()})`;
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${stop1}"/>
          <stop offset="100%" stop-color="${stop2}"/>
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" fill="url(#g)"/>
    </svg>
  `;
}
function rand() { return Math.floor(Math.random()*256) }


const generators = [ gradientAvatarSVG ]; // TODO impliment more generators from scripts\img_generation.py

export function generateCover(): { id: string; svg: string } {
  const id = nanoid();
  const svg = generators[Math.floor(Math.random()*generators.length)]();
  return { id, svg };
}
