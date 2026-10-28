function failWithSourceLocation(): never {
  throw new Error("Source map verification");
}
failWithSourceLocation();
