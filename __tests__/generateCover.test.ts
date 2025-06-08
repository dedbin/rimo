import { generateCover, generators, geometricAvatarSVG, gradientAvatarSVG, testCovers } from '@/lib/generateCover';
import { describe, it, expect } from 'vitest';


describe('generateCover', () => {
  it('generators return SVG markup', () => {
    expect(gradientAvatarSVG()).toMatch(/<svg[^>]*>/);
    expect(geometricAvatarSVG()).toMatch(/<svg[^>]*>/);
  });

  it('generateCover produces object with svg', () => {
    const cover = generateCover('gradient');
    expect(cover.name).toBe('gradient');
    expect(cover.svg).toMatch(/<svg[^>]*>/);
    expect(cover.id).toBeTruthy();
  });

  it('testCovers returns cover for each generator', () => {
    const covers = testCovers();
    expect(covers.length).toBe(generators.length);
  });
});