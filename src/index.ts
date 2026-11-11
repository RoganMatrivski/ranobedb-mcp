import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const API = "https://ranobedb.org/api/v0";
// NOTE: not in the API docs, this is the CDN the site uses for covers. Verify once.
const IMG = "https://images.ranobedb.org/";

// ---------- shared schema bits ----------
const and_or = z.enum(["and", "or"]);

// Accept a single value ("en", 195) or an array (["en"], [195]); optional.
const arr = <T extends z.ZodTypeAny>(t: T) =>
    z.preprocess(
        (v) => (v === undefined || Array.isArray(v) ? v : [v]),
        z.array(t).optional(),
    );

const lang = z
    .string()
    .describe("Language code, e.g. 'ja', 'en', 'zh-Hans', 'ko', 'fr', 'pt-br'");
const langs = arr(lang);
const formats = arr(z.enum(["digital", "print", "audio"]));
const ids = arr(z.coerce.number().int());

const paging = {
    q: z.string().optional().describe("Search text"),
    page: z.number().int().min(1).optional(),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Default 24, max 100"),
};

const releaseFilters = {
    rl: langs.describe("Release languages"),
    rll: and_or.optional().describe("Release languages logic"),
    rf: formats.describe("Release formats"),
    rfl: and_or.optional().describe("Release formats logic"),
    p: ids.describe("Publisher ids"),
    pl: and_or.optional().describe("Publisher logic"),
};

const staffFilters = {
    staff: ids.describe("Staff ids"),
    sl: and_or.optional().describe("Staff logic"),
};

// ---------- helpers ----------
type Params = Record<string, unknown>;

/** Arrays become repeated keys (?rl=en&rl=ja), same as the website. */
function toQuery(params: Params): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
        else sp.set(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : "";
}

/** Replace verbose image objects with a plain URL to save tokens. */
function slim(x: unknown): unknown {
    if (Array.isArray(x)) return x.map(slim);
    if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        if (typeof o.filename === "string" && "width" in o && "height" in o) {
            return { url: IMG + o.filename, nsfw: o.nsfw, spoiler: o.spoiler };
        }
        return Object.fromEntries(
            Object.entries(o).map(([k, v]) => [k, slim(v)]),
        );
    }
    return x;
}

async function call(path: string, params: Params = {}) {
    try {
        const res = await fetch(`${API}${path}${toQuery(params)}`, {
            headers: {
                Accept: "application/json",
                "User-Agent": "ranobedb-mcp/1.0",
            },
        });
        if (!res.ok) {
            return {
                isError: true,
                content: [
                    {
                        type: "text" as const,
                        text: `RanobeDB error ${res.status}: ${(await res.text()).slice(0, 500)}`,
                    },
                ],
            };
        }
        return {
            content: [
                {
                    type: "text" as const,
                    text: JSON.stringify(slim(await res.json())),
                },
            ],
        };
    } catch (e) {
        return {
            isError: true,
            content: [
                {
                    type: "text" as const,
                    text: `Request failed: ${e instanceof Error ? e.message : String(e)}`,
                },
            ],
        };
    }
}

const readOnly = { readOnlyHint: true, openWorldHint: true };
const idSchema = z.object({
    id: z.number().int().describe("RanobeDB numeric id"),
});

function createServer() {
    const server = new McpServer({ name: "RanobeDB", version: "1.0.0" });

    // Register a read-only tool: list endpoints pass params through, detail endpoints build a path.
    const list = <S extends z.ZodRawShape>(
        name: string,
        description: string,
        path: string,
        shape: S,
    ) =>
        server.registerTool(
            name,
            {
                description,
                inputSchema: z.object(shape),
                annotations: readOnly,
            },
            async (args: Params) => call(path, args),
        );

    const detail = (name: string, description: string, path: string) =>
        server.registerTool(
            name,
            { description, inputSchema: idSchema, annotations: readOnly },
            async ({ id }: { id: number }) => call(`/${path}/${id}`),
        );

    // ----- Books -----
    list(
        "search_books",
        "Search light novel volumes (books) on RanobeDB. Returns paginated results with title, romaji, language, release date (YYYYMMDD int) and cover URL.",
        "/books",
        {
            ...paging,
            ...releaseFilters,
            ...staffFilters,
            sort: z
                .enum([
                    "Relevance desc",
                    "Relevance asc",
                    "Title asc",
                    "Title desc",
                    "Release date asc",
                    "Release date desc",
                ])
                .optional(),
        },
    );
    detail(
        "get_book",
        "Get full details of a book/volume by id: titles, editions & staff, releases, publishers, parent series with tags.",
        "book",
    );

    // ----- Series -----
    list(
        "search_series",
        "Search light novel series on RanobeDB with filters for publication status, genres, tags, staff, publishers and release info. Genre/tag ids can be found via search_tags.",
        "/series",
        {
            ...paging,
            pubStatus: z
                .enum([
                    "ongoing",
                    "completed",
                    "hiatus",
                    "stalled",
                    "cancelled",
                    "unknown",
                ])
                .optional(),
            genresInclude: ids,
            genresExclude: ids,
            tagsInclude: ids,
            tagsExclude: ids,
            til: and_or.optional().describe("Tags include logic"),
            tel: and_or.optional().describe("Tags exclude logic"),
            ...releaseFilters,
            ...staffFilters,
            sort: z
                .enum([
                    "Relevance desc",
                    "Relevance asc",
                    "Title asc",
                    "Title desc",
                    "Start date asc",
                    "Start date desc",
                    "End date asc",
                    "End date desc",
                    "Num. books asc",
                    "Num. books desc",
                ])
                .optional(),
        },
    );
    detail(
        "get_series",
        "Get full details of a series by id: description, status, books, related series, staff, publishers, tags, external ids.",
        "series",
    );

    // ----- Releases -----
    list(
        "search_releases",
        "Search releases (specific print/digital/audio editions with ISBN, pages, store links). Supports a date range.",
        "/releases",
        {
            ...paging,
            ...releaseFilters,
            minDate: z
                .string()
                .optional()
                .describe("ISO date, e.g. 2025-01-01"),
            maxDate: z
                .string()
                .optional()
                .describe("ISO date, e.g. 2025-12-31"),
            sort: z
                .enum([
                    "Relevance desc",
                    "Relevance asc",
                    "Title asc",
                    "Title desc",
                    "Release date asc",
                    "Release date desc",
                    "Pages asc",
                    "Pages desc",
                ])
                .optional(),
        },
    );
    detail(
        "get_release",
        "Get full details of a release by id, including publishers and the books it contains.",
        "release",
    );

    // ----- Staff -----
    list(
        "search_staff",
        "Search staff (authors, illustrators, translators, etc.).",
        "/staff",
        {
            ...paging,
            lang: langs.describe("Staff language"),
            sort: z.enum(["Name asc", "Name desc"]).optional(),
        },
    );
    detail(
        "get_staff",
        "Get staff details by id, including aliases and external ids (pixiv, twitter, wikidata...).",
        "staff",
    );

    // ----- Publishers -----
    list(
        "search_publishers",
        "Search publishers and imprints.",
        "/publishers",
        {
            ...paging,
            lang: langs.describe("Publisher language"),
            sort: z.enum(["Name asc", "Name desc"]).optional(),
        },
    );
    detail(
        "get_publisher",
        "Get publisher details by id, including child publishers/imprints.",
        "publisher",
    );

    // ----- Tags -----
    list(
        "search_tags",
        "Search tags/genres. Use the returned ids with search_series genresInclude/tagsInclude etc.",
        "/tags",
        paging,
    );

    return server;
}

const handler = createMcpHandler(createServer);

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        return handler(request, env, ctx);
    },
} satisfies ExportedHandler<Env>;
