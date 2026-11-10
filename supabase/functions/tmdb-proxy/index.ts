import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TMDB_API_BASE = "https://api.themoviedb.org";
const TMDB_IMAGE_BASE = "https://image.tmdb.org";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, accept",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
};

Deno.serve(async (req: Request) => {
  // 1. 处理预检请求 (CORS)
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);

    // 2. 提取实际目标子路径（兼容 /functions/v1/tmdb-proxy 或 /tmdb-proxy 前缀）
    let subPath = url.pathname.replace(/^.*\/tmdb-proxy/, "");
    if (!subPath || subPath === "") {
      subPath = "/";
    }

    // 3. 根路径请求返回健康检查与使用示例
    if (subPath === "/") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "TMDB Edge Proxy (Supabase)",
          message: "TMDB 代理服务运行正常",
          sample_requests: {
            api: "/3/authentication?api_key=YOUR_API_KEY",
            movie_detail: "/3/movie/550?api_key=YOUR_API_KEY",
            image: "/t/p/w500/8b8R8l88Qje9dn9OE8PY05Nxl1X.jpg",
          },
        }, null, 2),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    // 4. 智能路由：海报/图片请求 (/t/p/...) 走 image.tmdb.org，其他走 api.themoviedb.org
    let targetBase = TMDB_API_BASE;
    if (subPath.startsWith("/t/p/")) {
      targetBase = TMDB_IMAGE_BASE;
    } else if (subPath.startsWith("/image/")) {
      targetBase = TMDB_IMAGE_BASE;
      subPath = subPath.replace(/^\/image/, "");
    }

    const targetUrl = new URL(targetBase + subPath + url.search);

    // 5. 转发请求头（过滤 host 头）
    const forwardHeaders = new Headers();
    for (const [key, value] of req.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== "host") {
        forwardHeaders.set(key, value);
      }
    }

    // 6. 向 TMDB 发起请求
    const upstreamResponse = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body: req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined,
    });

    // 7. 构造响应头并注入 CORS
    const responseHeaders = new Headers(upstreamResponse.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      responseHeaders.set(key, value);
    }
    responseHeaders.set("x-proxied-by", "supabase-tmdb-edge");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: "Proxy upstream request failed", details: err?.message || String(err) }),
      {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      }
    );
  }
});
