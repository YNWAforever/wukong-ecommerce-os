import http from "node:http";

const port = Number(process.env.PORT ?? 4173);
let approved = false;

const page = () => `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>Opak SHOPLINE pilot</title>
<style>body{font:16px system-ui;max-width:720px;margin:3rem auto;padding:0 1rem}label{display:block;margin:1rem 0}textarea,input{display:block;width:100%;padding:.6rem}button{margin:.4rem .4rem .4rem 0;padding:.6rem 1rem}#state{font-weight:700;margin:1rem 0}.evidence{border-left:4px solid #2b6;padding:.5rem 1rem}</style></head>
<body><h1>Opak Cellar SHOPLINE pilot</h1>
<section id="intake"><h2>建立上架草稿</h2>
<label for="listing-files">產品圖片或文件<input id="listing-files" type="file"></label>
<label for="listing-note">補充資料<textarea id="listing-note">Opak Cellar Riesling 2024, Germany, Mosel, Riesling, 750ml, 12.5% ABV, SKU OPAK-DEMO-001, HK$288</textarea></label>
<button id="create" type="button">建立上架草稿</button></section>
<section id="review" hidden><p id="state">待補資料</p><p class="evidence">來源證據：supplier-sheet.txt；瓶標；庫存：需要資料</p><button id="continue" type="button">進入審核</button>
<div id="fields" hidden><label for="title-en">英文標題<input id="title-en" value="Opak Cellar Riesling 2024"></label><button id="save" type="button">儲存修改</button><button id="approve" type="button">批准上架</button><div id="delivery" hidden><button id="csv" type="button" disabled>下載 SHOPLINE CSV</button><button id="publish" type="button" disabled>發佈至 SHOPLINE 測試連接</button></div></div></section>
<p id="message" role="status"></p>
<script>
const state=document.querySelector('#state'), message=document.querySelector('#message'), review=document.querySelector('#review'), fields=document.querySelector('#fields'), delivery=document.querySelector('#delivery'), csv=document.querySelector('#csv'), publish=document.querySelector('#publish');
document.querySelector('#create').onclick=()=>{document.querySelector('#intake').hidden=true;review.hidden=false;state.textContent='待補資料';message.textContent='AI 已完成提取；需要補充庫存資料。';};
document.querySelector('#continue').onclick=()=>{state.textContent='待審核';fields.hidden=false;};
document.querySelector('#save').onclick=()=>{message.textContent='已更新審核版本';};
document.querySelector('#approve').onclick=()=>{approved=true;state.textContent='已批准';delivery.hidden=false;csv.disabled=false;publish.disabled=false;message.textContent='批准已記錄';};
document.querySelector('#csv').onclick=async()=>{const r=await fetch('/api/listings/draft-1/deliver',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'csv'})}); if(r.ok) message.textContent='CSV 已建立';};
document.querySelector('#publish').onclick=async()=>{const r=await fetch('/api/listings/draft-1/deliver',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'shopline_api'})}); const body=await r.json(); if(r.ok) message.textContent=body.status==='queued'?'queued/mock remote_123':'已發佈';};
</script></body></html>`;

const server = http.createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (request.method === "GET" && (request.url === "/" || request.url === "/listings/new")) {
    approved = false;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page());
    return;
  }
  if (request.method === "POST" && request.url === "/api/listings/draft-1/deliver") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const method = JSON.parse(body || "{}").method;
    if (!approved) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "approval_required" }));
      return;
    }
    if (method === "csv") {
      response.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
      response.end("SKU,English Title,Traditional Chinese Title\r\nOPAK-DEMO-001,Opak Cellar Riesling 2024,Opak Cellar 雷司令 2024\r\n");
      return;
    }
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "queued", jobId: "mock-job-123", remoteProductId: "remote_123" }));
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

server.listen(port, "127.0.0.1");
