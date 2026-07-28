import { expect, test } from "bun:test";
import {
  ingredientName,
  ingredientNames,
} from "../src/ingredients";

test("parses dot-delimited compound ingredients with parenthesized quantities", () => {
  const spec = "Azoxystrobin.Propiconazole SE 18.71(7.01+11.7) %";

  expect(ingredientName(spec)).toBe("Azoxystrobin.Propiconazole");
  expect(ingredientNames(spec)).toEqual([
    "Azoxystrobin",
    "Propiconazole",
  ]);
});

test("normalizes plus-delimited compound ingredients", () => {
  const spec = "Acetamiprid+Emamectin benzoate SL (10+6) %";

  expect(ingredientName(spec)).toBe("Acetamiprid.Emamectin benzoate");
  expect(ingredientNames(spec)).toEqual([
    "Acetamiprid",
    "Emamectin benzoate",
  ]);
});

test("parses compound specifications that omit the formulation code", () => {
  const spec = "Emamectin benzoate+Lufenuron 3.2(0.7+2.5) %";

  expect(ingredientName(spec)).toBe("Emamectin benzoate.Lufenuron");
  expect(ingredientNames(spec)).toEqual([
    "Emamectin benzoate",
    "Lufenuron",
  ]);
});

test("does not split plus signs that belong to an ingredient name", () => {
  const spec =
    "Gibberellic acid.Gibberellin A4+7 PA 2.7(2.5+0.2) %";

  expect(ingredientNames(spec)).toEqual([
    "Gibberellic acid",
    "Gibberellin A4+7",
  ]);
});

test("keeps unsupported microbial specifications intact", () => {
  const spec = "B.T. subsp. Kurstaki WP 16 BIU/kg";

  expect(ingredientName(spec)).toBe(spec);
  expect(ingredientNames(spec)).toEqual([spec]);
});

test("uses the stored normalized name when the raw specification is absent", () => {
  expect(ingredientName(null)).toBeNull();
  expect(ingredientNames(null, "mancozeb")).toEqual(["mancozeb"]);
  expect(ingredientNames(null, null)).toEqual([]);
});

test("falls back intact when ingredient and quantity counts disagree", () => {
  const spec = "Alpha.Beta.Gamma WP 10(2+8) %";

  expect(ingredientName(spec)).toBe(spec);
  expect(ingredientNames(spec)).toEqual([spec]);
});
