import { derivative, parse } from "mathjs/number";
import type { ConstantNode, FunctionNode, MathNode, OperatorNode, ParenthesisNode, SymbolNode } from "mathjs";

import { MAX_GRAPH_FORMULA_LENGTH } from "./model";

export type GraphOperator = "=" | "<" | ">" | "<=" | ">=";
export interface GraphDomainBoundary {
  readonly evaluate: (value: number) => number;
  readonly validate: (value: number) => number;
}
export type GraphExpressionCompilation = Readonly<
  { ok: true; axis: "x" | "y"; operator: GraphOperator; evaluate: (value: number) => number; domainBoundaries: readonly GraphDomainBoundary[] } |
  { ok: false; error: string }
>;

type Scalar = (value: number) => number;
interface MathFunction { readonly arity: readonly number[]; readonly evaluate: (...values: number[]) => number }

export const MAX_GRAPH_AST_NODES = 96;
export const MAX_GRAPH_AST_DEPTH = 16;
const MAX_COMPILED_EXPRESSIONS = 192;
const MAX_DOMAIN_BOUNDARIES = 16;
const MAX_DERIVATIVE_INPUT_NODES = 32;
const MAX_DERIVATIVE_ATTEMPTS = 8;

const FUNCTIONS: Readonly<Record<string, MathFunction>> = {
  sin: { arity: [1], evaluate: Math.sin }, cos: { arity: [1], evaluate: Math.cos },
  tan: { arity: [1], evaluate: Math.tan }, cot: { arity: [1], evaluate: (x) => 1 / Math.tan(x) },
  asin: { arity: [1], evaluate: Math.asin }, acos: { arity: [1], evaluate: Math.acos },
  atan: { arity: [1], evaluate: Math.atan }, sinh: { arity: [1], evaluate: Math.sinh },
  cosh: { arity: [1], evaluate: Math.cosh }, tanh: { arity: [1], evaluate: Math.tanh },
  sqrt: { arity: [1], evaluate: Math.sqrt }, cbrt: { arity: [1], evaluate: Math.cbrt },
  abs: { arity: [1], evaluate: Math.abs }, exp: { arity: [1], evaluate: Math.exp },
  ln: { arity: [1], evaluate: Math.log },
  log: { arity: [1, 2], evaluate: (x, base) => base === undefined ? Math.log(x) : Math.log(x) / Math.log(base) },
  log10: { arity: [1], evaluate: Math.log10 }, log2: { arity: [1], evaluate: Math.log2 },
  min: { arity: [2, 3, 4], evaluate: Math.min }, max: { arity: [2, 3, 4], evaluate: Math.max },
};

function normalizedFormula(formula: string): string {
  return formula.trim().toLowerCase().replace(/[−–—]/g, "-").replace(/[×·⋅]/g, "*")
    .replace(/÷/g, "/").replace(/π/g, "pi").replace(/≤/g, "<=").replace(/≥/g, ">=")
    .replace(/²/g, "^2").replace(/³/g, "^3").replace(/\btg\b/g, "tan")
    .replace(/\bctg\b/g, "cot").replace(/\blg\b/g, "log10");
}

function expressionParts(formula: string): { axis: "x" | "y"; operator: GraphOperator; body: string } {
  const direct = /^(x|y|f\s*\(\s*x\s*\))\s*(<=|>=|<|>|=)\s*(.+)$/.exec(formula);
  if (direct) return { axis: direct[1] === "x" ? "x" : "y", operator: direct[2] as GraphOperator, body: direct[3] };
  const reversed = /^(.+?)\s*(<=|>=|<|>|=)\s*([xy])$/.exec(formula);
  if (reversed) {
    const reverse: Record<GraphOperator, GraphOperator> = { "=": "=", "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
    return { axis: reversed[3] as "x" | "y", operator: reverse[reversed[2] as GraphOperator], body: reversed[1] };
  }
  if (/[=<>]/.test(formula)) throw new Error("Используйте y = f(x), x = f(y) или неравенство с x или y слева.");
  return { axis: "y", operator: "=", body: formula };
}

function scalarEvaluator(root: MathNode, variable: "x" | "y"): Scalar {
  let nodes = 0;
  function visit(node: MathNode, depth: number): Scalar {
    nodes += 1;
    if (nodes > MAX_GRAPH_AST_NODES || depth > MAX_GRAPH_AST_DEPTH) throw new Error("Формула слишком сложная. Разделите её на более простые выражения.");
    if (node.type === "ConstantNode") {
      const value = (node as ConstantNode).value;
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("В формуле допустимы только конечные числа.");
      return () => value;
    }
    if (node.type === "SymbolNode") {
      const name = (node as SymbolNode).name;
      if (name === variable) return (value) => value;
      if (name === "pi") return () => Math.PI;
      if (name === "e") return () => Math.E;
      throw new Error(`Неизвестная переменная «${name}». Здесь можно использовать ${variable}, pi и e.`);
    }
    if (node.type === "ParenthesisNode") return visit((node as ParenthesisNode).content, depth + 1);
    if (node.type === "FunctionNode") {
      const call = node as FunctionNode;
      const name = call.fn.type === "SymbolNode" ? call.fn.name : "";
      const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
      if (!fn || !fn.arity.includes(call.args.length)) throw new Error("Неизвестная функция или неверное число аргументов.");
      const args = call.args.map((argument) => visit(argument, depth + 1));
      return (value) => fn.evaluate(...args.map((argument) => argument(value)));
    }
    if (node.type === "OperatorNode") {
      const operation = node as OperatorNode;
      const op = operation.op as string;
      if (!["+", "-", "*", "/", "^"].includes(op) || operation.args.length > 2) throw new Error("Доступны операции +, −, ×, / и степень ^.");
      const args = operation.args.map((argument) => visit(argument, depth + 1));
      if (args.length === 1 && (op === "+" || op === "-")) return (value) => (op === "-" ? -1 : 1) * args[0](value);
      if (args.length !== 2) throw new Error("Неверная математическая операция.");
      const [left, right] = args;
      switch (op) {
        case "+": return (value) => left(value) + right(value);
        case "-": return (value) => left(value) - right(value);
        case "*": return (value) => left(value) * right(value);
        case "/": return (value) => left(value) / right(value);
        case "^": return (value) => Math.pow(left(value), right(value));
      }
    }
    throw new Error("Это выражение не поддерживается. Используйте обычную числовую формулу.");
  }
  return visit(root, 0);
}

function zeroFactors(node: MathNode): MathNode[] {
  if (node.type === "ParenthesisNode") return zeroFactors((node as ParenthesisNode).content);
  if (node.type === "OperatorNode") {
    const operation = node as OperatorNode;
    if ((operation.op as string) === "*") return operation.args.flatMap(zeroFactors);
    if (["^", "/"].includes(operation.op)) return zeroFactors(operation.args[0]);
  }
  if (node.type === "FunctionNode") {
    const call = node as FunctionNode;
    if (["abs", "sqrt", "cbrt"].includes(call.fn.name)) return zeroFactors(call.args[0]);
  }
  return [node];
}

// User input still goes only through the scalar whitelist. These bounded hints
// let the plotter find denominator zeros even when a pole has the same sign on
// both sides. mathjs differentiates the safe AST to expose repeated roots;
// stationary points are accepted only if the original denominator is zero.
function domainBoundaries(root: MathNode, variable: "x" | "y"): readonly GraphDomainBoundary[] {
  const boundaries: GraphDomainBoundary[] = [];
  const seen = new Set<string>();
  let derivativeAttempts = 0;
  const hasVariable = (node: MathNode): boolean => node.filter((child) =>
    child.type === "SymbolNode" && (child as SymbolNode).name === variable).length > 0;
  function addZeroTarget(target: MathNode): void {
    if (!hasVariable(target) || boundaries.length >= MAX_DOMAIN_BOUNDARIES) return;
    const validate = scalarEvaluator(target, variable);
    for (const factor of zeroFactors(target)) {
      for (const differentiated of [false, true]) {
        if (boundaries.length >= MAX_DOMAIN_BOUNDARIES) return;
        try {
          if (differentiated && (derivativeAttempts >= MAX_DERIVATIVE_ATTEMPTS ||
            factor.filter(() => true).length > MAX_DERIVATIVE_INPUT_NODES)) continue;
          if (differentiated) derivativeAttempts += 1;
          const candidate = differentiated ? derivative(factor, variable, { simplify: false }) : factor;
          if (!hasVariable(candidate)) continue;
          const key = `${candidate.toString()}|${target.toString()}`;
          if (seen.has(key)) continue;
          const evaluate = scalarEvaluator(candidate, variable);
          seen.add(key);
          boundaries.push(Object.freeze({ evaluate, validate }));
        } catch {
          // An optional derivative may exceed the scalar AST limits. The
          // original formula remains supported and its normal sampler bounded.
        }
      }
    }
  }
  root.traverse((node) => {
    if (boundaries.length >= MAX_DOMAIN_BOUNDARIES) return;
    if (node.type === "OperatorNode") {
      const operation = node as OperatorNode;
      if ((operation.op as string) === "/") addZeroTarget(operation.args[1]);
      if ((operation.op as string) === "^" && !hasVariable(operation.args[1]) &&
        scalarEvaluator(operation.args[1], variable)(0) < 0) addZeroTarget(operation.args[0]);
    }
    if (node.type === "FunctionNode") {
      const call = node as FunctionNode;
      if (["ln", "log", "log2", "log10"].includes(call.fn.name)) addZeroTarget(call.args[0]);
      if ((call.fn.name === "tan" || call.fn.name === "cot") && hasVariable(call.args[0])) {
        const argument = scalarEvaluator(call.args[0], variable);
        const trigonometric = call.fn.name === "tan" ? Math.cos : Math.sin;
        const evaluate = (value: number): number => trigonometric(argument(value));
        boundaries.push(Object.freeze({ evaluate, validate: evaluate }));
      }
    }
  });
  return Object.freeze(boundaries);
}

function createCompiler(): (formula: string) => GraphExpressionCompilation {
  const cache = new Map<string, GraphExpressionCompilation>();
  return (formula) => {
    if (formula.length > MAX_GRAPH_FORMULA_LENGTH) return { ok: false, error: `Формула длиннее ${MAX_GRAPH_FORMULA_LENGTH} символов.` };
    const cached = cache.get(formula);
    if (cached) return cached;
    let result: GraphExpressionCompilation;
    try {
      const normalized = normalizedFormula(formula);
      if (!normalized) throw new Error("Введите функцию или неравенство.");
      const { axis, operator, body } = expressionParts(normalized);
      const root = parse(body);
      const variable = axis === "y" ? "x" : "y";
      const evaluate = scalarEvaluator(root, variable);
      const boundaries = domainBoundaries(root, variable);
      result = Object.freeze({ ok: true, axis, operator, domainBoundaries: boundaries, evaluate: (value: number) => {
        if (!Number.isFinite(value)) return NaN;
        const output = evaluate(value);
        return Number.isFinite(output) ? output : NaN;
      } });
    } catch (error) {
      result = Object.freeze({ ok: false, error: error instanceof Error && !error.message.includes("char ")
        ? error.message : "Проверьте формулу: скобки, знаки операций и аргументы функций." });
    }
    if (cache.size >= MAX_COMPILED_EXPRESSIONS) cache.delete(cache.keys().next().value!);
    cache.set(formula, result);
    return result;
  };
}

export const compileGraphExpression = createCompiler();
