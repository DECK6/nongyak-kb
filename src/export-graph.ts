import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ingredientNames } from "./ingredients";
import { matchesRevoked } from "./revoked";

type GraphNode = {
  id: string;
  type: "product" | "ingredient" | "crop" | "crop_class" | "pest" | "company";
  label: string;
  props?: Record<string, string | boolean>;
};

type GraphEdge = {
  source: string;
  target: string;
  type: "has_ingredient" | "applies_to" | "controls" | "member_of" | "made_by";
  props?: Record<string, string>;
};

type ProductRow = {
  pesti_code: string;
  pesti_kor_name: string;
  brand_name: string | null;
  comp_name: string | null;
  eng_name: string | null;
  ingredient_name: string | null;
  toxic_name: string | null;
  use_name: string | null;
};

type RevokedRow = {
  prdlst_regist_no: string;
  pesti_kor_name: string | null;
  brand_name: string | null;
  comp_name: string | null;
};

type CropRow = {
  crop_cd: string;
  crop_name: string;
  crop_lrcl_cd: string | null;
  crop_lrcl_nm: string | null;
};

type PestRow = {
  name: string;
};

type UsageRow = {
  pesti_code: string;
  disease_use_seq: string;
  crop_cd: string | null;
  crop_name: string | null;
  pest_name: string | null;
  dilut_unit: string | null;
  use_suittime: string | null;
  use_num: string | null;
};

function productLabel(name: string, brand: string | null): string {
  return brand ? `${name}(${brand})` : name;
}

export function exportGraph(opts?: { dbPath?: string; outPath?: string }): string {
  const dbPath = resolve(opts?.dbPath ?? "data/kb.sqlite");
  const outPath = resolve(opts?.outPath ?? "dist/graph.json");
  const db = new Database(dbPath, { readonly: true, strict: true });
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  function addNode(node: GraphNode): void {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, node);
      return;
    }
    const props = { ...existing.props, ...node.props };
    if (existing.props?.revoked || node.props?.revoked) props.revoked = true;
    nodes.set(node.id, {
      ...existing,
      label: existing.label || node.label,
      props: Object.keys(props).length > 0 ? props : undefined,
    });
  }

  function addEdge(edge: GraphEdge, discriminator = ""): void {
    edges.set(`${edge.type}\u0000${edge.source}\u0000${edge.target}\u0000${discriminator}`, edge);
  }

  try {
    const products = db
      .query(`
        SELECT
          pesti_code, pesti_kor_name, brand_name, comp_name,
          eng_name, ingredient_name, toxic_name, use_name
        FROM products
        ORDER BY pesti_code
      `)
      .all() as ProductRow[];
    const revokedProducts = db
      .query(`
        SELECT prdlst_regist_no, pesti_kor_name, brand_name, comp_name
        FROM revoked_products
        ORDER BY prdlst_regist_no
      `)
      .all() as RevokedRow[];
    const crops = db
      .query(`
        SELECT crop_cd, crop_name, crop_lrcl_cd, crop_lrcl_nm
        FROM crops
        ORDER BY crop_cd
      `)
      .all() as CropRow[];
    const pests = db.query("SELECT name FROM pests ORDER BY pest_id").all() as PestRow[];
    const usages = db
      .query(`
        SELECT
          u.pesti_code, u.disease_use_seq, u.crop_cd, c.crop_name,
          pe.name AS pest_name, u.dilut_unit, u.use_suittime, u.use_num
        FROM usage_rules u
        LEFT JOIN crops c ON c.crop_cd = u.crop_cd
        LEFT JOIN pests pe ON pe.pest_id = u.pest_id
        ORDER BY u.pesti_code, u.disease_use_seq
      `)
      .all() as UsageRow[];

    for (const product of products) {
      const productId = `product:${product.pesti_code}`;
      const props: Record<string, string | boolean> = {
        company: product.comp_name ?? "",
        toxicity: product.toxic_name ?? "",
        useName: product.use_name ?? "",
      };
      if (revokedProducts.some((revoked) => matchesRevoked(product, revoked))) props.revoked = true;
      addNode({
        id: productId,
        type: "product",
        label: productLabel(product.pesti_kor_name, product.brand_name),
        props,
      });

      for (const ingredientName of ingredientNames(
        product.eng_name,
        product.ingredient_name,
      )) {
        const ingredientId = `ingredient:${ingredientName}`;
        addNode({ id: ingredientId, type: "ingredient", label: ingredientName });
        addEdge({ source: productId, target: ingredientId, type: "has_ingredient" });
      }
      if (product.comp_name) {
        const companyId = `company:${product.comp_name}`;
        addNode({ id: companyId, type: "company", label: product.comp_name });
        addEdge({ source: productId, target: companyId, type: "made_by" });
      }
    }

    for (const revoked of revokedProducts) {
      const matchingProduct = products.find((product) => matchesRevoked(product, revoked));
      const productId = `product:${matchingProduct?.pesti_code ?? revoked.prdlst_regist_no}`;
      if (!matchingProduct) {
        addNode({
          id: productId,
          type: "product",
          label: productLabel(revoked.pesti_kor_name ?? revoked.prdlst_regist_no, revoked.brand_name),
          props: { company: revoked.comp_name ?? "", revoked: true },
        });
      }
      if (revoked.comp_name) {
        const companyId = `company:${revoked.comp_name}`;
        addNode({ id: companyId, type: "company", label: revoked.comp_name });
        addEdge({ source: productId, target: companyId, type: "made_by" });
      }
    }

    for (const crop of crops) {
      const cropId = `crop:${crop.crop_cd}`;
      addNode({ id: cropId, type: "crop", label: crop.crop_name });
      if (crop.crop_lrcl_cd) {
        const cropClassId = `cropclass:${crop.crop_lrcl_cd}`;
        addNode({
          id: cropClassId,
          type: "crop_class",
          label: crop.crop_lrcl_nm ?? crop.crop_lrcl_cd,
        });
        addEdge({ source: cropId, target: cropClassId, type: "member_of" });
      }
    }

    for (const pest of pests) {
      addNode({ id: `pest:${pest.name}`, type: "pest", label: pest.name });
    }

    for (const usage of usages) {
      const productId = `product:${usage.pesti_code}`;
      if (usage.crop_cd) {
        const cropId = `crop:${usage.crop_cd}`;
        addNode({ id: cropId, type: "crop", label: usage.crop_name ?? usage.crop_cd });
        addEdge(
          {
            source: productId,
            target: cropId,
            type: "applies_to",
            props: {
              diseaseUseSeq: usage.disease_use_seq,
              dilutUnit: usage.dilut_unit ?? "",
              useSuittime: usage.use_suittime ?? "",
              useNum: usage.use_num ?? "",
            },
          },
          usage.disease_use_seq,
        );
      }
      if (usage.pest_name) {
        const pestId = `pest:${usage.pest_name}`;
        addNode({ id: pestId, type: "pest", label: usage.pest_name });
        addEdge({ source: productId, target: pestId, type: "controls" });
      }
    }

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      `${JSON.stringify({ nodes: [...nodes.values()], edges: [...edges.values()] }, null, 2)}\n`,
      "utf8",
    );
    return outPath;
  } finally {
    db.close();
  }
}

if (import.meta.main) console.log(exportGraph());
