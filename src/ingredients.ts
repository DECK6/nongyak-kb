type ParsedIngredientSpec = {
  displayName: string;
  names: string[];
};

const SINGLE_INGREDIENT_SPEC =
  /^(.+?)\s+[A-Z]{1,5}\s*\d+(?:\.\d+)?(?:\s*%)?\s*$/;

const COMPOUND_INGREDIENT_SPEC =
  /^(.+?)\s+(?:[A-Z]{1,5}\s+)?(?:\d+(?:\.\d+)?)?\s*\((\d+(?:\.\d+)?(?:\+\d+(?:\.\d+)?)+)\)\s*%\s*$/;

function splitConstituents(
  value: string,
  expectedCount: number,
): string[] | null {
  // PSIS는 대부분 "."을 쓰지만 일부 행은 "+"를 성분 구분자로 쓴다.
  // Gibberellin A4+7처럼 이름 자체에 +가 있으므로 함량 개수와 일치할 때만 채택한다.
  for (const delimiter of [".", "+"]) {
    const names = value.split(delimiter).map((name) => name.trim());
    if (
      names.length === expectedCount &&
      names.every((name) => name.length > 0)
    ) {
      return names;
    }
  }
  return null;
}

function parseIngredientSpec(value: string): ParsedIngredientSpec | null {
  const compoundMatch = value.match(COMPOUND_INGREDIENT_SPEC);
  if (compoundMatch) {
    const quantities = compoundMatch[2].split("+");
    const names = splitConstituents(
      compoundMatch[1].trim(),
      quantities.length,
    );
    if (names) {
      return {
        displayName: names.join("."),
        names,
      };
    }
    return null;
  }

  const singleMatch = value.match(SINGLE_INGREDIENT_SPEC);
  if (singleMatch) {
    const name = singleMatch[1].trim();
    return { displayName: name, names: [name] };
  }
  return null;
}

export function ingredientName(engName: string | null): string | null {
  if (engName === null) {
    return null;
  }
  return parseIngredientSpec(engName)?.displayName ?? engName;
}

export function ingredientNames(
  engName: string | null,
  fallbackName: string | null = engName,
): string[] {
  if (engName !== null) {
    const parsed = parseIngredientSpec(engName);
    if (parsed) {
      return parsed.names;
    }
  }
  const fallback = fallbackName?.trim();
  return fallback ? [fallback] : [];
}
