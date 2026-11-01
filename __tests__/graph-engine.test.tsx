import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { compileGraphExpression, MAX_GRAPH_AST_DEPTH } from "@/lib/board/graph/expression";
import { createGraphSettings, MAX_GRAPH_EXPRESSIONS, MAX_STORED_GRAPH_EXPRESSIONS, parseGraphSettings, parseGraphViewport, sortedGraphExpressions } from "@/lib/board/graph/model";
import { GraphPlot, graphPlotSegments } from "@/lib/board/graph/plot";
import type { GraphExpressionCompilation } from "@/lib/board/graph/expression";
import type { GraphSettings } from "@/types/board-canvas";

function compiled(formula: string): Extract<GraphExpressionCompilation, { ok: true }> {
  const result = compileGraphExpression(formula);
  if (!result.ok) throw new Error(result.error);
  return result;
}

function graph(formula: string): GraphSettings {
  return { ...createGraphSettings(), expressions: { one: { formula, color: "#2563eb", visible: true, order: 0 } } };
}

function documentFor(settings: GraphSettings): Document {
  return new DOMParser().parseFromString(renderToStaticMarkup(<GraphPlot graph={settings} width={640} height={440} />), "text/html");
}

describe("graph settings", () => {
  it("creates separate defaults and clones nested validated input", () => {
    const first = createGraphSettings();
    const second = createGraphSettings();
    first.expressions.parabola.formula = "y=3x";
    first.viewport.xMin = -10;
    expect(second.expressions.parabola.formula).toBe("y = x^2");
    expect(second.viewport.xMin).toBe(-8);
    const parsed = parseGraphSettings(first)!;
    parsed.expressions.parabola.color = "#ffffff";
    parsed.viewport.xMin = -20;
    expect(first.expressions.parabola.color).toBe("#2563eb");
    expect(first.viewport.xMin).toBe(-10);
  });

  it("preserves incomplete formulas as editable data and accepts an empty graph", () => {
    expect(parseGraphSettings(graph("y="))).not.toBeNull();
    expect(parseGraphSettings({ ...createGraphSettings(), expressions: {} })?.expressions).toEqual({});
  });

  it.each([
    { viewport: { xMin: 0, xMax: 0, yMin: -5, yMax: 5 } },
    { viewport: { xMin: 1, xMax: -1, yMin: -5, yMax: 5 } },
    { viewport: { xMin: 0, xMax: 0.00001, yMin: -5, yMax: 5 } },
    { viewport: { xMin: -1_000_000, xMax: 1_000_000, yMin: -5, yMax: 5 } },
    { viewport: { xMin: -Infinity, xMax: 10, yMin: -5, yMax: 5 } },
    { showGrid: "yes" },
    { expressions: [] },
    { expressions: { "bad id": { formula: "x", color: "#2563eb", visible: true, order: 0 } } },
    { expressions: Object.fromEntries([["__proto__", { formula: "x", color: "#2563eb", visible: true, order: 0 }]]) },
    { expressions: { one: { formula: "x", color: "red", visible: true, order: 0 } } },
    { expressions: { one: { formula: "x", color: "#2563eb", visible: 1, order: 0 } } },
    { expressions: { one: { formula: "x".repeat(257), color: "#2563eb", visible: true, order: 0 } } },
    { expressions: { one: { formula: "x", color: "#2563eb", visible: true, order: NaN } } },
  ])("rejects invalid settings %j", (patch) => {
    expect(parseGraphSettings({ ...createGraphSettings(), ...patch })).toBeNull();
  });

  it("rejects excessive rows and inherited required fields", () => {
    const expression = { formula: "x", color: "#2563eb", visible: true, order: 0 };
    expect(parseGraphSettings({ ...createGraphSettings(), expressions: Object.fromEntries(
      Array.from({ length: MAX_STORED_GRAPH_EXPRESSIONS + 1 }, (_, index) => [`row-${index}`, expression]),
    ) })).toBeNull();
    expect(parseGraphSettings(Object.create(createGraphSettings()))).toBeNull();
    expect(parseGraphViewport(Object.create({ xMin: -5, xMax: 5, yMin: -5, yMax: 5 }))).toBeNull();
  });

  it("sorts equal row positions deterministically by stable id", () => {
    const settings = graph("x");
    settings.expressions = {
      z: { ...settings.expressions.one, order: 2 },
      b: { ...settings.expressions.one, order: 1 },
      a: { ...settings.expressions.one, order: 1 },
    };
    expect(sortedGraphExpressions(settings).map(([id]) => id)).toEqual(["a", "b", "z"]);
  });
});

describe("bounded scalar mathjs adapter", () => {
  it.each([
    ["y = x^2", 3, 9], ["2x + 1", -2, -3], ["f(x) = 2(x+1)", 2, 6],
    ["y = sin(pi/2) + cos(0)", 1, 2], ["y = ln(e)", 0, 1],
    ["y = log(8,2)", 0, 3], ["y = sqrt(abs(x))", -4, 2],
    ["y = 2×x² − 1", 3, 17], ["y = tg(π / 4)", 0, 1],
    ["y = exp(0) + lg(100)", 0, 3], ["y = -x^2", 3, -9],
    ["x = y^2", -3, 9], ["x=cos(y)", 0, 1],
  ])("evaluates %s", (formula, x, result) => {
    expect(compiled(String(formula)).evaluate(Number(x))).toBeCloseTo(Number(result), 10);
  });

  it.each([
    ["y < x^2", "y", "<"], ["y ≤ 2x+1", "y", "<="],
    ["x >= sin(y)", "x", ">="], ["x > 3", "x", ">"],
    ["x^2 < y", "y", ">"], ["3 >= x", "x", "<="],
  ])("recognizes the graph direction of %s", (formula, axis, operator) => {
    expect(compiled(formula)).toMatchObject({ axis, operator });
  });

  it.each([
    "", "y=", "y=x+y", "a*x", "y=x; import('evil')", "random()", "factorial(999999)", "x!",
    "evaluate('1+1')", "parse('x')", "constructor", "x.constructor", "x['constructor']",
    "x=[1,2,3]", "y=1:9999999", "y={a:1}", "y=true", "y=Infinity", "y=x?1:2",
    "y=x==2", "x^2+y^2<=4", "y=sin(x,2)", "y=999e999", "y=x&2",
    "floor(x)", "ceil(x)", "round(x)", "sign(x)",
    `y=${"sin(".repeat(MAX_GRAPH_AST_DEPTH + 1)}x${")".repeat(MAX_GRAPH_AST_DEPTH + 1)}`,
    "y=" + "x".repeat(257),
  ])("rejects unsupported or unsafe input: %s", (formula) => {
    const result = compileGraphExpression(formula);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(5);
  });

  it("uses real domain semantics and returns nonfinite sentinels without throwing", () => {
    expect(compiled("sqrt(x)").evaluate(-1)).toBeNaN();
    expect(compiled("1/x").evaluate(0)).toBeNaN();
    expect(compiled("exp(x)").evaluate(10_000)).toBeNaN();
    expect(compiled("ln(x)").evaluate(-2)).toBeNaN();
    expect(compiled("x").evaluate(Infinity)).toBeNaN();
  });

  it("does not expose or evaluate JavaScript or object properties", () => {
    const property = Object.getOwnPropertyDescriptor(globalThis, "graphEngineAttack");
    expect(compileGraphExpression("y = globalThis.graphEngineAttack = 1").ok).toBe(false);
    expect(Object.getOwnPropertyDescriptor(globalThis, "graphEngineAttack")).toEqual(property);
  });
});

describe("Mafs plotting adapter", () => {
  it("renders multiple colored functions, visible axes and a shaded inequality in SVG", () => {
    const settings = createGraphSettings();
    settings.expressions.region = { formula: "y < sin(x)", color: "#059669", visible: true, order: 2 };
    const document = documentFor(settings);
    expect(document.querySelectorAll("svg")).toHaveLength(1);
    expect(document.querySelectorAll("[data-graph-expression]")).toHaveLength(3);
    expect(document.querySelectorAll("text").length).toBeGreaterThan(10);
    expect(document.querySelector('[data-graph-expression="parabola"] path')?.getAttribute("style")).toContain("#2563eb");
    expect(document.querySelector('[data-graph-expression="region"] [data-graph-shading]')?.getAttribute("d")).toMatch(/M[\s\S]*z/);
    expect(document.querySelector('[data-graph-expression="region"] path[stroke-dasharray]')?.getAttribute("stroke-dasharray")).toBe("4,8");
  });

  it("renders a solid inclusive boundary and independently honors hidden and invalid rows", () => {
    const settings = createGraphSettings();
    settings.expressions.parabola.visible = false;
    settings.expressions.line.formula = "y=";
    settings.expressions.region = { formula: "x >= sin(y)", color: "#059669", visible: true, order: 2 };
    const document = documentFor(settings);
    expect(document.querySelectorAll("[data-graph-expression]")).toHaveLength(1);
    expect(document.querySelector('[data-graph-expression="region"]')?.getAttribute("data-graph-axis")).toBe("x");
    expect(document.querySelector('[data-graph-expression="region"] path[stroke-dasharray]')?.getAttribute("stroke-dasharray")).toBe("");
  });

  it.each(["1/x", "tan(x)", "sqrt(x)", "ln(x)", "y < 1/x", "x >= 1/y"])("handles domains and poles of %s without invalid path numbers", (formula) => {
    const document = documentFor(graph(formula));
    const markup = document.documentElement.outerHTML;
    expect(markup).not.toMatch(/\b(?:NaN|Infinity)\b/);
    for (const path of document.querySelectorAll("path[d]")) expect(path.getAttribute("d")).not.toMatch(/M\s*$/);
  });

  it("lifts the pen at 1/x and tan poles instead of joining opposite branches", () => {
    const reciprocal = documentFor(graph("1/x"));
    expect(reciprocal.querySelectorAll("[data-graph-expression] path")).toHaveLength(2);
    const paths = [...reciprocal.querySelectorAll("[data-graph-expression] path")].map((path) => path.getAttribute("d")!);
    for (const path of paths) {
      const points = [...path.matchAll(/(?:M|L)\s*(-?[\d.e+-]+)\s+(-?[\d.e+-]+)/g)].map((point) => [Number(point[1]), Number(point[2])]);
      expect(points.length).toBeGreaterThan(10);
      expect(points.every(([x]) => x < 0) || points.every(([x]) => x > 0)).toBe(true);
    }
    const tangent = documentFor(graph("tan(x)"));
    expect(tangent.querySelectorAll("[data-graph-expression] path").length).toBeGreaterThan(3);
  });

  it.each(["1/(x-0.01)", "tan(x)", "1000 + tan(x)"])("keeps discontinuities of %s after vertical zoom-out or a vertical offset", (formula) => {
    const settings = graph(formula);
    settings.viewport.yMin = -100;
    settings.viewport.yMax = 2_000;
    const document = documentFor(settings);
    expect(document.querySelectorAll("[data-graph-expression] path").length).toBeGreaterThan(1);
    const segments = graphPlotSegments(compiled(formula).evaluate, [-8, 8], [-100, 2_000]);
    expect(segments.limited).toBe(false);
    expect(segments.intervals.every(([left, right]) => left >= 0.01 || right < 0.01)).toBe(formula.startsWith("1/"));
  });

  it.each([
    ["1/(x-0.01)^2", 0.01], ["-1/(x-0.01)^2", 0.01],
    ["1000 + 1/(x+0.017)^2", -0.017], ["1000 - 1/(x+0.017)^2", -0.017],
    ["(x-0.01)^(-2)", 0.01], ["1/(x*x-0.02*x+0.0001)", 0.01],
    ["tan(x)^2", Math.PI / 2],
  ])("does not bridge the same-side pole in %s", (formula, pole) => {
    const settings = graph(String(formula));
    settings.viewport.yMin = -10_000;
    settings.viewport.yMax = 10_000;
    const document = documentFor(settings);
    const paths = [...document.querySelectorAll("[data-graph-expression] path")];
    expect(paths.length).toBeGreaterThan(1);
    for (const path of paths) {
      const points = [...path.getAttribute("d")!.matchAll(/(?:M|L)\s*(-?[\d.e+-]+)\s+(-?[\d.e+-]+)/g)]
        .map((point) => Number(point[1]));
      expect(points.some((x) => x < Number(pole)) && points.some((x) => x > Number(pole))).toBe(false);
    }
  });

  it.each([
    "1000000*(x-0.01)^2", "exp(40x)", "exp(-10000*(x-0.01)^2)",
    "1/((x-0.01)^2 + 0.000001)", "1/(0.0001+(x-0.01)^4)",
  ])("keeps the steep continuous curve %s connected", (formula) => {
    const settings = graph(formula);
    settings.viewport.yMin = -100;
    settings.viewport.yMax = 10_000;
    const document = documentFor(settings);
    expect(document.querySelectorAll("[data-graph-expression] path")).toHaveLength(1);
  });

  it("splits shaded same-side poles and keeps domain hints bounded", () => {
    const settings = graph("y < 1/(x-0.01)^2");
    settings.viewport.yMax = 10_000;
    const document = documentFor(settings);
    expect(document.querySelectorAll("[data-graph-shading]")).toHaveLength(2);
    expect(document.querySelectorAll("clipPath")).toHaveLength(2);
    expect(compiled("1/(x-0.01)^2").domainBoundaries.length).toBeLessThanOrEqual(16);
  });

  it("clips separate inequality regions at poles and leaves a valid steep line connected", () => {
    const inequality = documentFor(graph("y < 1/x"));
    expect(inequality.querySelectorAll("[data-graph-shading]")).toHaveLength(2);
    expect(inequality.querySelectorAll("clipPath")).toHaveLength(2);
    const segments = graphPlotSegments((x) => x * 10_000, [-8, 8], [-5, 5]);
    expect(segments.limited).toBe(false);
    expect(segments.intervals).toEqual([[-8, 8]]);
  });

  it("bounds dense-pole work, grid labels and output size at extreme viewports", () => {
    const dense = graphPlotSegments(Math.tan, [-1_000, 1_000], [-5, 5]);
    expect(dense.intervals.length).toBeLessThanOrEqual(16);
    const settings = graph("sin(x)");
    settings.viewport = { xMin: -500_000, xMax: 500_000, yMin: -500_000, yMax: 500_000 };
    const document = documentFor(settings);
    expect(document.querySelectorAll("text").length).toBeLessThan(150);
    expect(document.documentElement.outerHTML.length).toBeLessThan(500_000);
    expect(document.documentElement.outerHTML).not.toMatch(/\b(?:NaN|Infinity)\b/);
  });

  it("preserves stored concurrent additions while bounding visible rendering deterministically", () => {
    const settings = graph("x");
    settings.expressions = Object.fromEntries(Array.from({ length: MAX_GRAPH_EXPRESSIONS + 3 }, (_, index) =>
      [`row-${index.toString().padStart(2, "0")}`, { formula: "x", color: "#2563eb", visible: index !== 0, order: index }]));
    expect(parseGraphSettings(settings)).not.toBeNull();
    const document = documentFor(settings);
    expect(document.querySelectorAll("[data-graph-expression]")).toHaveLength(MAX_GRAPH_EXPRESSIONS);
    expect(document.querySelector('[data-graph-expression="row-00"]')).toBeNull();
    expect(document.querySelector('[data-graph-expression="row-12"]')).not.toBeNull();
    expect(document.querySelector('[data-graph-expression="row-13"]')).toBeNull();
    expect(document.querySelector(".rimo-graph-warning")?.textContent).toContain("12");
  });
});
