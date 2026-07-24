import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writer, DataFactory } from 'n3';

const ONTOLOGY = "https://deck6ix.github.io/nongyak-kb/ontology#";
const DATA = "https://deck6ix.github.io/nongyak-kb/data/";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const SH = "http://www.w3.org/ns/shacl#";

const { blankNode, literal, namedNode } = DataFactory;

type ProductRow = {
  pesti_code: string;
  pesti_kor_name: string;
  brand_name: string | null;
  comp_name: string | null;
  ingredient_name: string | null;
  indict_symbl: string | null;
  apply_first_reg_date: string | null;
  toxic_name: string | null;
  fish_toxic_gubun: string | null;
};

type CropRow = {
  crop_cd: string;
  crop_name: string;
  crop_lrcl_cd: string | null;
  crop_lrcl_nm: string | null;
};

type PestRow = {
  pest_id: number;
  name: string;
};

type UsageRuleRow = {
  pesti_code: string;
  disease_use_seq: string;
  crop_cd: string | null;
  pest_id: number | null;
  pesti_use: string | null;
  dilut_unit: string | null;
  use_suittime: string | null;
  use_num: string | null;
};

type RevokedProductRow = {
  prdlst_regist_no: string;
  pesti_kor_name: string | null;
};

type AnalysisMethodRow = {
  tchprduct_ingr_sn: string;
  gnrl_nm_eng: string | null;
  gnrl_nm_kor: string | null;
};

const classNames = [
  "Product",
  "ActiveIngredient",
  "Crop",
  "CropClass",
  "Pest",
  "Company",
  "UsageRule",
  "RevokedProduct",
  "AnalysisMethod",
] as const;

function ontologyTerm(name: string) {
  return namedNode(`${ONTOLOGY}${name}`);
}

function dataTerm(kind: string, id: string) {
  return namedNode(`${DATA}${kind}-${id}`);
}

function slug(value: string): string {
  return value.trim().replace(/[\s()（）]+/g, "-");
}

function addType(writer: Writer, subject: ReturnType<typeof namedNode>, type: string) {
  writer.addQuad(subject, namedNode(`${RDF}type`), ontologyTerm(type));
}

function addLiteral(
  writer: Writer,
  subject: ReturnType<typeof namedNode>,
  predicate: ReturnType<typeof namedNode>,
  value: string | null,
) {
  if (value !== null && value.trim() !== "") {
    writer.addQuad(subject, predicate, literal(value));
  }
}

function serialize(writer: Writer): string {
  const result: { error?: Error; output?: string } = {};
  writer.end((error, output) => {
    if (error) {
      result.error = error;
      return;
    }
    result.output = output as string;
  });
  if (result.error) {
    throw result.error;
  }
  if (result.output === undefined) {
    throw new Error("N3 Writer did not return serialized Turtle");
  }
  return result.output;
}

function createOntology(
  products: ProductRow[],
  crops: CropRow[],
  pests: PestRow[],
  usageRules: UsageRuleRow[],
  revokedProducts: RevokedProductRow[],
  analysisMethods: AnalysisMethodRow[],
): string {
  const writer = new Writer({
    prefixes: {
      nyk: ONTOLOGY,
      nykd: DATA,
      rdf: RDF,
      rdfs: RDFS,
    },
  });
  const rdfType = namedNode(`${RDF}type`);
  const rdfsClass = namedNode(`${RDFS}Class`);
  const rdfsLabel = namedNode(`${RDFS}label`);

  for (const className of classNames) {
    const subject = ontologyTerm(className);
    writer.addQuad(subject, rdfType, rdfsClass);
    writer.addQuad(subject, rdfsLabel, literal(className));
  }

  const companySubjects = new Map<string, ReturnType<typeof namedNode>>();
  const ingredientSubjects = new Map<string, ReturnType<typeof namedNode>>();
  for (const product of products) {
    const subject = dataTerm("product", slug(product.pesti_code));
    addType(writer, subject, "Product");
    writer.addQuad(subject, rdfsLabel, literal(product.pesti_kor_name));
    addLiteral(writer, subject, ontologyTerm("brandName"), product.brand_name);
    addLiteral(writer, subject, ontologyTerm("toxicity"), product.toxic_name);
    addLiteral(
      writer,
      subject,
      ontologyTerm("fishToxicity"),
      product.fish_toxic_gubun,
    );
    addLiteral(
      writer,
      subject,
      ontologyTerm("modeOfAction"),
      product.indict_symbl,
    );
    addLiteral(
      writer,
      subject,
      ontologyTerm("registeredDate"),
      product.apply_first_reg_date,
    );

    if (product.comp_name !== null && product.comp_name.trim() !== "") {
      const company =
        companySubjects.get(product.comp_name) ??
        dataTerm("company", slug(product.comp_name));
      if (!companySubjects.has(product.comp_name)) {
        companySubjects.set(product.comp_name, company);
        addType(writer, company, "Company");
        writer.addQuad(company, rdfsLabel, literal(product.comp_name));
      }
      writer.addQuad(subject, ontologyTerm("companyName"), company);
    }

    if (
      product.ingredient_name !== null &&
      product.ingredient_name.trim() !== ""
    ) {
      const ingredient =
        ingredientSubjects.get(product.ingredient_name) ??
        dataTerm("ingredient", slug(product.ingredient_name));
      if (!ingredientSubjects.has(product.ingredient_name)) {
        ingredientSubjects.set(product.ingredient_name, ingredient);
        addType(writer, ingredient, "ActiveIngredient");
        writer.addQuad(
          ingredient,
          rdfsLabel,
          literal(product.ingredient_name),
        );
      }
      writer.addQuad(subject, ontologyTerm("hasIngredient"), ingredient);
    }
  }

  const cropClassSubjects = new Map<string, ReturnType<typeof namedNode>>();
  for (const crop of crops) {
    const subject = dataTerm("crop", slug(crop.crop_cd));
    addType(writer, subject, "Crop");
    writer.addQuad(subject, rdfsLabel, literal(crop.crop_name));

    if (
      crop.crop_lrcl_cd !== null &&
      crop.crop_lrcl_cd.trim() !== "" &&
      crop.crop_lrcl_nm !== null &&
      crop.crop_lrcl_nm.trim() !== "" &&
      !cropClassSubjects.has(crop.crop_lrcl_cd)
    ) {
      const cropClass = dataTerm("cropclass", slug(crop.crop_lrcl_cd));
      cropClassSubjects.set(crop.crop_lrcl_cd, cropClass);
      addType(writer, cropClass, "CropClass");
      writer.addQuad(cropClass, rdfsLabel, literal(crop.crop_lrcl_nm));
    }
  }

  const pestNames = new Map<number, string>();
  for (const pest of pests) {
    pestNames.set(pest.pest_id, pest.name);
    const subject = dataTerm("pest", slug(pest.name));
    addType(writer, subject, "Pest");
    writer.addQuad(subject, rdfsLabel, literal(pest.name));
  }

  for (const usageRule of usageRules) {
    const subject = dataTerm(
      "usage",
      `${slug(usageRule.pesti_code)}-${slug(usageRule.disease_use_seq)}`,
    );
    addType(writer, subject, "UsageRule");
    writer.addQuad(
      subject,
      ontologyTerm("hasProduct"),
      dataTerm("product", slug(usageRule.pesti_code)),
    );
    if (usageRule.crop_cd !== null && usageRule.crop_cd.trim() !== "") {
      writer.addQuad(
        subject,
        ontologyTerm("hasCrop"),
        dataTerm("crop", slug(usageRule.crop_cd)),
      );
    }
    if (usageRule.pest_id !== null) {
      const pestName = pestNames.get(usageRule.pest_id);
      if (pestName !== undefined) {
        writer.addQuad(
          subject,
          ontologyTerm("hasPest"),
          dataTerm("pest", slug(pestName)),
        );
      }
    }
    addLiteral(
      writer,
      subject,
      ontologyTerm("dilution"),
      usageRule.dilut_unit,
    );
    addLiteral(
      writer,
      subject,
      ontologyTerm("applicationTiming"),
      usageRule.pesti_use,
    );
    addLiteral(
      writer,
      subject,
      ontologyTerm("preHarvestInterval"),
      usageRule.use_suittime,
    );
    addLiteral(
      writer,
      subject,
      ontologyTerm("maxApplications"),
      usageRule.use_num,
    );
  }

  for (const revokedProduct of revokedProducts) {
    const subject = dataTerm(
      "revoked-product",
      slug(revokedProduct.prdlst_regist_no),
    );
    addType(writer, subject, "RevokedProduct");
    addLiteral(
      writer,
      subject,
      rdfsLabel,
      revokedProduct.pesti_kor_name ?? revokedProduct.prdlst_regist_no,
    );
  }

  for (const analysisMethod of analysisMethods) {
    const subject = dataTerm(
      "analysis-method",
      slug(analysisMethod.tchprduct_ingr_sn),
    );
    addType(writer, subject, "AnalysisMethod");
    addLiteral(
      writer,
      subject,
      rdfsLabel,
      analysisMethod.gnrl_nm_kor ??
        analysisMethod.gnrl_nm_eng ??
        analysisMethod.tchprduct_ingr_sn,
    );
  }

  return serialize(writer);
}

function createShapes(): string {
  const writer = new Writer({
    prefixes: {
      nyk: ONTOLOGY,
      rdf: RDF,
      rdfs: RDFS,
      sh: SH,
    },
  });
  const rdfType = namedNode(`${RDF}type`);
  const rdfFirst = namedNode(`${RDF}first`);
  const rdfRest = namedNode(`${RDF}rest`);
  const rdfNil = namedNode(`${RDF}nil`);
  const nodeShape = namedNode(`${SH}NodeShape`);
  const targetClass = namedNode(`${SH}targetClass`);
  const property = namedNode(`${SH}property`);
  const path = namedNode(`${SH}path`);
  const minCount = namedNode(`${SH}minCount`);
  const shClass = namedNode(`${SH}class`);

  for (const className of classNames) {
    const shape = ontologyTerm(`${className}Shape`);
    writer.addQuad(shape, rdfType, nodeShape);
    writer.addQuad(shape, targetClass, ontologyTerm(className));
  }

  const productLabel = blankNode("product-label");
  writer.addQuad(ontologyTerm("ProductShape"), property, productLabel);
  writer.addQuad(productLabel, path, namedNode(`${RDFS}label`));
  writer.addQuad(productLabel, minCount, literal(1));

  const usageProduct = blankNode("usage-product");
  writer.addQuad(ontologyTerm("UsageRuleShape"), property, usageProduct);
  writer.addQuad(usageProduct, path, ontologyTerm("hasProduct"));
  writer.addQuad(usageProduct, minCount, literal(1));
  writer.addQuad(usageProduct, shClass, ontologyTerm("Product"));

  const cropBranch = blankNode("usage-crop-branch");
  const cropProperty = blankNode("usage-crop-property");
  writer.addQuad(cropBranch, property, cropProperty);
  writer.addQuad(cropProperty, path, ontologyTerm("hasCrop"));
  writer.addQuad(cropProperty, minCount, literal(1));
  writer.addQuad(cropProperty, shClass, ontologyTerm("Crop"));

  const pestBranch = blankNode("usage-pest-branch");
  const pestProperty = blankNode("usage-pest-property");
  writer.addQuad(pestBranch, property, pestProperty);
  writer.addQuad(pestProperty, path, ontologyTerm("hasPest"));
  writer.addQuad(pestProperty, minCount, literal(1));
  writer.addQuad(pestProperty, shClass, ontologyTerm("Pest"));

  const orHead = blankNode("usage-or-head");
  const orTail = blankNode("usage-or-tail");
  writer.addQuad(ontologyTerm("UsageRuleShape"), namedNode(`${SH}or`), orHead);
  writer.addQuad(orHead, rdfFirst, cropBranch);
  writer.addQuad(orHead, rdfRest, orTail);
  writer.addQuad(orTail, rdfFirst, pestBranch);
  writer.addQuad(orTail, rdfRest, rdfNil);

  return serialize(writer);
}

export function exportTtl(opts?: {
  dbPath?: string;
  outDir?: string;
}): { ontologyPath: string; shapesPath: string } {
  const dbPath = resolve(
    opts?.dbPath ?? resolve(import.meta.dir, "../data/kb.sqlite"),
  );
  const outDir = resolve(opts?.outDir ?? resolve(import.meta.dir, "../dist"));
  const db = new Database(dbPath, { readonly: true, strict: true });

  try {
    const products = db
      .query<ProductRow, []>(
        `SELECT
          pesti_code, pesti_kor_name, brand_name, comp_name, ingredient_name,
          indict_symbl, apply_first_reg_date, toxic_name, fish_toxic_gubun
        FROM products
        ORDER BY pesti_code`,
      )
      .all();
    const crops = db
      .query<CropRow, []>(
        `SELECT crop_cd, crop_name, crop_lrcl_cd, crop_lrcl_nm
        FROM crops
        ORDER BY crop_cd`,
      )
      .all();
    const pests = db
      .query<PestRow, []>(
        "SELECT pest_id, name FROM pests ORDER BY pest_id",
      )
      .all();
    const usageRules = db
      .query<UsageRuleRow, []>(
        `SELECT
          pesti_code, disease_use_seq, crop_cd, pest_id, pesti_use,
          dilut_unit, use_suittime, use_num
        FROM usage_rules
        ORDER BY pesti_code, disease_use_seq`,
      )
      .all();
    const revokedProducts = db
      .query<RevokedProductRow, []>(
        `SELECT prdlst_regist_no, pesti_kor_name
        FROM revoked_products
        ORDER BY prdlst_regist_no`,
      )
      .all();
    const analysisMethods = db
      .query<AnalysisMethodRow, []>(
        `SELECT tchprduct_ingr_sn, gnrl_nm_eng, gnrl_nm_kor
        FROM analysis_methods
        ORDER BY tchprduct_ingr_sn`,
      )
      .all();
    const ontology = createOntology(
      products,
      crops,
      pests,
      usageRules,
      revokedProducts,
      analysisMethods,
    );
    const shapes = createShapes();
    const ontologyPath = resolve(outDir, "ontology.ttl");
    const shapesPath = resolve(outDir, "shapes.ttl");

    mkdirSync(outDir, { recursive: true });
    writeFileSync(ontologyPath, ontology, "utf8");
    writeFileSync(shapesPath, shapes, "utf8");
    return { ontologyPath, shapesPath };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const { ontologyPath, shapesPath } = exportTtl();
  console.log(ontologyPath);
  console.log(shapesPath);
}
