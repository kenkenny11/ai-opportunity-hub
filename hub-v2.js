import express from "express";

function esc(v){
  return String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function limit(v,d=12,m=30){
  const n=parseInt(v,10);
  return Number.isFinite(n)?Math.min(Math.max(n,1),m):d;
}

async function ensureSchema(pool){
  await pool.query("ALTER TABLE ai_tools ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'Web', ADD COLUMN IF NOT EXISTS use_cases TEXT DEFAULT '', ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active', ADD COLUMN IF NOT EXISTS last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  await pool.query("CREATE TABLE IF NOT EXISTS ai_jobs (id SERIAL PRIMARY KEY,company TEXT NOT NULL,title TEXT NOT NULL,location TEXT DEFAULT 'Remote',remote INTEGER DEFAULT 1,salary TEXT DEFAULT '',job_type TEXT DEFAULT 'Full-time',category TEXT DEFAULT 'AI Jobs',description TEXT DEFAULT '',apply_url TEXT NOT NULL,source TEXT DEFAULT '',posted_at TIMESTAMP,verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,status TEXT DEFAULT 'active',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
  await pool.query("CREATE TABLE IF NOT EXISTS opportunities (id SERIAL PRIMARY KEY,title TEXT NOT NULL,type TEXT DEFAULT 'Digital Opportunity',description TEXT DEFAULT '',requirements TEXT DEFAULT '',earning_method TEXT DEFAULT '',difficulty TEXT DEFAULT 'Beginner',source_url TEXT NOT NULL,verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,status TEXT DEFAULT 'active',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
  await pool.query("CREATE TABLE IF NOT EXISTS resources (id SERIAL PRIMARY KEY,title TEXT NOT NULL,category TEXT DEFAULT 'Free Resources',description TEXT DEFAULT '',url TEXT NOT NULL,free INTEGER DEFAULT 1,source TEXT DEFAULT '',verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,status TEXT DEFAULT 'active',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
  await pool.query("CREATE TABLE IF NOT EXISTS tutorials (id SERIAL PRIMARY KEY,title TEXT NOT NULL,topic TEXT DEFAULT 'AI',difficulty TEXT DEFAULT 'Beginner',content TEXT DEFAULT '',tools_required TEXT DEFAULT '',source TEXT DEFAULT '',updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,status TEXT DEFAULT 'active')");
  await pool.query("CREATE TABLE IF NOT EXISTS hub_users (telegram_id BIGINT PRIMARY KEY,username TEXT DEFAULT '',first_name TEXT DEFAULT '',language_code TEXT DEFAULT '',interests TEXT DEFAULT '',first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,search_count INTEGER DEFAULT 0,tool_clicks INTEGER DEFAULT 0,job_clicks INTEGER DEFAULT 0,premium_purchases INTEGER DEFAULT 0)");

  const seeds=[
    ["ChatGPT","Web, Android, iOS","writing, research, brainstorming, coding"],
    ["Claude","Web, Android, iOS","writing, analysis, coding, documents"],
    ["Google Gemini","Web, Android, iOS","research, writing, multimodal tasks"],
    ["Perplexity","Web, Android, iOS","research, AI search"],
    ["Canva","Web, Android, iOS","design, social posts, presentations"],
    ["Leonardo AI","Web","image generation, creative content"],
    ["Runway","Web","AI video generation, video editing"],
    ["Vidpal","Web","AI video, reels, content automation"],
    ["ElevenLabs","Web","AI voice, speech, audio"],
    ["GitHub Copilot","Web, IDE","coding, software development"],
    ["Cursor","Desktop","AI coding"],
    ["Hugging Face","Web","AI models, datasets, developer tools"],
    ["Google AI Studio","Web","AI model experiments, API development"],
    ["NotebookLM","Web, Android","research, source-grounded notes"],
    ["Gamma","Web","presentations, documents, web pages"],
    ["Twin","Web","AI automation, workflows"]
  ];
  for(const s of seeds){
    await pool.query("UPDATE ai_tools SET platform=$2,use_cases=$3,last_checked=CURRENT_TIMESTAMP,status='active' WHERE LOWER(name)=LOWER($1)",s);
  }

  const resources=[
    ["Google AI Studio","Browser workspace for experimenting with Google AI models and APIs.","https://aistudio.google.com/","Google"],
    ["Hugging Face","AI models, datasets and developer resources.","https://huggingface.co/","Hugging Face"],
    ["NotebookLM","Research and note-taking with user-provided sources.","https://notebooklm.google.com/","Google"]
  ];
  for(const r of resources){
    await pool.query("INSERT INTO resources(title,category,description,url,free,source) SELECT $1,'Free Resources',$2,$3,1,$4 WHERE NOT EXISTS(SELECT 1 FROM resources WHERE LOWER(title)=LOWER($1))",r);
  }

  const tutorials=[
    ["How to choose an AI tool","AI Tools","Define the task, check the official site and free tier, test one small workflow, then compare results.","Any AI tool"],
    ["How to find AI jobs","AI Jobs","Use verified job sources, filter by location, read requirements and apply through the original source.","Job search tools"],
    ["How to use AI for content","Content","Start with a clear topic, draft with AI, verify facts, add useful examples and measure response.","AI writing and design tools"]
  ];
  for(const t of tutorials){
    await pool.query("INSERT INTO tutorials(title,topic,difficulty,content,tools_required,source) SELECT $1,$2,'Beginner',$3,$4,'AI Opportunity Hub' WHERE NOT EXISTS(SELECT 1 FROM tutorials WHERE LOWER(title)=LOWER($1))",t);
  }
}

function miniAppHtml(base){
  const b=String(base||"https://ai-opportunity-hub.onrender.com").replace(/\/$/,"");
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>AI Opportunity Hub</title>",
    "<script src=\"https://telegram.org/js/telegram-web-app.js?63\"></script>",
    "<style>:root{font-family:system-ui;color:#12233f;background:#f4f8ff}*{box-sizing:border-box}body{margin:0}.top{background:#0b63ce;color:white;padding:18px 16px}.wrap{max-width:760px;margin:auto;padding:12px}.search{background:white;padding:12px;border-radius:16px;margin-bottom:12px}input{width:100%;padding:13px;border:1px solid #ccd9ea;border-radius:12px;font-size:15px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px}button{border:0;border-radius:12px;padding:12px 8px;font-weight:700;background:white;color:#0b63ce;box-shadow:0 2px 9px #10233f18}.card{background:white;border-radius:15px;padding:14px;margin:10px 0;box-shadow:0 2px 10px #10233f12}.title{font-weight:800}.meta,.small{font-size:12px;color:#60708a;margin:5px 0}.desc{font-size:14px;line-height:1.45}a{color:#0b63ce;font-weight:700;text-decoration:none}.empty{text-align:center;color:#60708a;padding:20px}@media(min-width:600px){.grid{grid-template-columns:repeat(4,1fr)}}</style></head>",
    "<body><header class=\"top\"><b>🤖 AI Opportunity Hub</b><div>Tools • Jobs • Opportunities • Free resources • Learning</div></header>",
    "<main class=\"wrap\"><div class=\"search\"><input id=\"q\" placeholder=\"Tell me what you need…\"></div>",
    "<div class=\"grid\"><button data-v=\"tools\">🤖 AI Tools</button><button data-v=\"jobs\">💼 AI Jobs</button><button data-v=\"opportunities\">💰 Make Money</button><button data-v=\"resources\">🆓 Free Stuff</button><button data-v=\"tutorials\">🎓 Learn AI</button><button data-v=\"trending\">🔥 Trending</button><button data-v=\"all\">📚 All</button><button data-v=\"home\">🏠 Home</button></div>",
    "<section id=\"out\"><div class=\"empty\">Choose a service or search for something.</div></section></main>",
    "<script>",
    "const API="+JSON.stringify(b)+";const tg=window.Telegram&&window.Telegram.WebApp;if(tg){tg.ready();tg.expand()}const out=document.getElementById('out'),q=document.getElementById('q');let timer;",
    "function esc(s){return String(s??'').replace(/[&<>\\\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\\\"':'&quot;',\"'\":'&#39;'}[m]))}",
    "function card(x){const u=x.url||x.apply_url||x.source_url;return '<article class=\"card\"><div class=\"title\">'+esc(x.name||x.title||'Item')+'</div><div class=\"meta\">'+esc(x.category||x.type||x.company||x.location||'')+'</div><div class=\"desc\">'+esc(x.description||x.content||x.body||'')+'</div>'+(x.pricing?'<div class=\"small\">Pricing: '+esc(x.pricing)+'</div>':'')+(x.free_tier?'<div class=\"small\">Free: '+esc(x.free_tier)+'</div>':'')+(u?'<p><a href=\"'+esc(u)+'\" target=\"_blank\">Open ↗</a></p>':'')+'</article>'}",
    "async function load(v,term){out.innerHTML='<div class=\"empty\">Loading…</div>';try{const path=v==='home'?'/api/hub/trending':'/api/hub/'+encodeURIComponent(v);const r=await fetch(API+path+(term?'?q='+encodeURIComponent(term):''));const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');out.innerHTML=(d.items||[]).map(card).join('')||'<div class=\"empty\">No matching items yet.</div>'}catch(e){out.innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'}}",
    "document.querySelectorAll('button[data-v]').forEach(x=>x.onclick=()=>load(x.dataset.v,''));q.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>load('all',q.value.trim()),350)};",
    "</script></body></html>"
  ].join("\\n");
}

export function registerHubV2(app,{pool,telegram}){
  let readyPromise=null;
  async function ready(){if(!readyPromise)readyPromise=ensureSchema(pool);await readyPromise;}

  async function search(table,fields,q,lim){
    const term=String(q||"").trim();
    const values=[];
    let where=table==="ai_tools"?"active=1 AND status='active'":"status='active'";
    if(term){
      values.push("%"+term+"%");
      where+=" AND ("+fields.map(f=>f+" ILIKE $1").join(" OR ")+")";
    }
    values.push(lim);
    return pool.query("SELECT * FROM "+table+" WHERE "+where+" ORDER BY id DESC LIMIT $"+values.length,values);
  }

  async function get(type,q){
    if(type==="tools")return {title:"🤖 AI Tools",type:"tools",items:(await search("ai_tools",["name","category","description","platform","use_cases","pricing","free_tier"],q,16)).rows};
    if(type==="jobs")return {title:"💼 AI Jobs",type:"jobs",items:(await search("ai_jobs",["company","title","location","category","description"],q,12)).rows};
    if(type==="opportunities")return {title:"💰 Make Money",type:"opportunities",items:(await search("opportunities",["title","type","description","requirements","earning_method"],q,12)).rows};
    if(type==="resources")return {title:"🆓 Free Resources",type:"resources",items:(await search("resources",["title","category","description","source"],q,12)).rows};
    if(type==="tutorials")return {title:"🎓 Learn AI",type:"tutorials",items:(await search("tutorials",["title","topic","content","tools_required"],q,12)).rows};
    if(type==="trending"){
      const r=await pool.query("SELECT id,title,body,category,source_url FROM content WHERE status='published' ORDER BY published_at DESC NULLS LAST,id DESC LIMIT 10");
      return {title:"🔥 Trending",type:"trending",items:r.rows};
    }
    if(type==="all"){
      const a=await get("tools",q),b=await get("jobs",q),c=await get("opportunities",q),d=await get("resources",q);
      return {title:"🔎 Results",type:"search",items:[...a.items,...b.items,...c.items,...d.items].slice(0,20)};
    }
    return {title:"AI Opportunity Hub",type:"hub",items:[]};
  }

  function format(title,items){
    if(!items.length)return "<b>"+esc(title)+"</b>\\n\\nNo matching items yet. Send me a more specific request.";
    const lines=["<b>"+esc(title)+"</b>"];
    for(const x of items.slice(0,8)){
      const n=x.name||x.title||"Item",u=x.url||x.apply_url||x.source_url,d=x.description||x.content||x.body||"";
      lines.push("\\n<b>• "+esc(n)+"</b>"+(x.company?"\\n🏢 "+esc(x.company):"")+(x.category?"\\n🏷️ "+esc(x.category):"")+(x.location?"\\n📍 "+esc(x.location):"")+"\\n"+esc(String(d).slice(0,450))+(u?"\\n🔗 <a href=\""+esc(u)+"\">Open</a>":""));
    }
    return lines.join("\\n");
  }

  async function askFreeAI(question, payload){
    const key=process.env.OPENROUTER_API_KEY;
    if(!key)return null;
    const context=JSON.stringify(payload).slice(0,12000);
    const prompt="Answer the member using only the supplied AI Opportunity Hub data. Request: "+question+"\\nData: "+context+"\\nRules: do not invent pricing, salary, features, eligibility or URLs. Give up to 5 useful matches and explain briefly why each matches. Include URLs from the data only. Keep under 600 words.";
    try{
      const r=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json","HTTP-Referer":"https://ai-opportunity-hub.onrender.com","X-Title":"AI Opportunity Hub"},body:JSON.stringify({model:"openrouter/free",messages:[{role:"system",content:"You are the factual AI Opportunity Hub assistant. Use only supplied data."},{role:"user",content:prompt}],temperature:0.1,max_tokens:600})});
      if(!r.ok)return null;
      const d=await r.json();
      return d.choices?.[0]?.message?.content?.trim()||null;
    }catch{return null;}
  }

  async function answer(q){
    const l=q.toLowerCase();
    let type=/job|hiring|career|vacanc|employment/.test(l)?"jobs":/make money|earn|income|freelance|side hustle|opportunit/.test(l)?"opportunities":/learn|tutorial|how do i|teach|guide/.test(l)?"tutorials":/free resource|free stuff/.test(l)?"resources":"tools";
    const p=await get(type,q);
    if(type==="tools"&&/android/.test(l))p.items=p.items.filter(x=>/android/i.test(x.platform||"")||/android/i.test(x.description||""));
    if(type==="tools"&&/free|no cost|gratis/.test(l))p.items=p.items.filter(x=>/free/i.test((x.pricing||"")+" "+(x.free_tier||"")));
    const ai=await askFreeAI(q,{category:p.title,items:p.items});
    return ai||format(p.title,p.items);
  }

  const menu={
    inline_keyboard:[
      [{text:"🤖 AI Tools",callback_data:"hub:tools"},{text:"💼 AI Jobs",callback_data:"hub:jobs"}],
      [{text:"💰 Make Money",callback_data:"hub:opportunities"},{text:"📱 Android AI",callback_data:"hub:android"}],
      [{text:"🆓 Free Stuff",callback_data:"hub:resources"},{text:"🎓 Learn AI",callback_data:"hub:tutorials"}],
      [{text:"🔥 Trending",callback_data:"hub:trending"},{text:"🔎 Ask AI",callback_data:"hub:ask"}],
      [{text:"🚀 Open AI Hub",web_app:{url:(process.env.PUBLIC_BASE_URL||"https://ai-opportunity-hub.onrender.com")+"/miniapp"}},{text:"⭐ Premium",callback_data:"menu:premium"}]
    ]
  };

  app.use("/telegram/webhook",async(req,res,next)=>{
    if(req.method!=="POST")return next();
    try{
      await ready();
      const u=req.body||{},m=u.message,c=u.callback_query,id=m?.chat?.id||c?.message?.chat?.id||c?.from?.id;
      if(!id)return next();
      const user=m?.from||c?.from;
      if(user?.id){
        await pool.query("INSERT INTO hub_users(telegram_id,username,first_name,language_code) VALUES($1,$2,$3,$4) ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,first_name=EXCLUDED.first_name,language_code=EXCLUDED.language_code,last_active=CURRENT_TIMESTAMP",[user.id,user.username||"",user.first_name||"",user.language_code||""]);
      }
      const data=String(c?.data||""),text=String(m?.text||"").trim(),cmd=text.split(/\\s+/)[0].toLowerCase();
      const send=x=>telegram("sendMessage",{chat_id:id,...x});

      if(c){
        if(data==="hub:home"){
          await telegram("answerCallbackQuery",{callback_query_id:c.id,text:"Opening AI Hub"});
          await send({text:"🤖 <b>AI Opportunity Hub</b>\\n\\nTell me what you need, or choose a service.",parse_mode:"HTML",reply_markup:menu});
          return res.sendStatus(200);
        }
        if(data==="hub:ask"){
          await telegram("answerCallbackQuery",{callback_query_id:c.id,text:"Ask AI"});
          await send({text:"🔎 <b>Ask AI</b>\\n\\nSend a normal message describing what you need. I will search the Hub.",parse_mode:"HTML",reply_markup:menu});
          return res.sendStatus(200);
        }
        if(data==="hub:android"){
          await telegram("answerCallbackQuery",{callback_query_id:c.id,text:"Loading Android AI"});
          const r=await pool.query("SELECT * FROM ai_tools WHERE active=1 AND status='active' AND platform ILIKE '%Android%' ORDER BY name LIMIT 12");
          await send({text:format("📱 Android AI",r.rows),parse_mode:"HTML",reply_markup:menu});
          return res.sendStatus(200);
        }
        if(data.startsWith("hub:")){
          await telegram("answerCallbackQuery",{callback_query_id:c.id,text:"Loading"});
          const p=await get(data.slice(4),"");
          await send({text:format(p.title,p.items),parse_mode:"HTML",reply_markup:menu});
          return res.sendStatus(200);
        }
        if(data==="menu:home"){
          await telegram("answerCallbackQuery",{callback_query_id:c.id,text:"Main menu"});
          await send({text:"🤖 <b>AI Opportunity Hub</b>\\n\\nTell me what you need, or choose a service.",parse_mode:"HTML",reply_markup:menu});
          return res.sendStatus(200);
        }

        // Handle buttons from older bot messages too, so no stale menu is left broken.
        const legacy = {
          "menu:tools":"tools",
          "menu:jobs":"jobs",
          "menu:free":"resources",
          "menu:learn":"tutorials",
          "menu:opportunities":"opportunities",
          "menu:android":"android",
          "menu:trending":"trending"
        };
        if(legacy[data]){
          await telegram("answerCallbackQuery",{callback_query_id:c.id,text:"Loading"});
          if(data==="menu:android"){
            const r=await pool.query("SELECT * FROM ai_tools WHERE active=1 AND status='active' AND platform ILIKE '%Android%' ORDER BY name LIMIT 12");
            await send({text:format("📱 Android AI",r.rows),parse_mode:"HTML",reply_markup:menu});
            return res.sendStatus(200);
          }
          if(data==="menu:opportunities"){
            let r=await get("opportunities","");
            if(!r.items.length){
              const fallback=await pool.query("SELECT id,title,body AS description,category,source_url FROM content WHERE status='published' AND category ILIKE '%Opportunity%' ORDER BY published_at DESC NULLS LAST,id DESC LIMIT 8");
              r={title:"💰 Make Money",items:fallback.rows};
            }
            await send({text:format(r.title,r.items),parse_mode:"HTML",reply_markup:menu});
            return res.sendStatus(200);
          }
          const r=await get(legacy[data],"");
          await send({text:format(r.title,r.items),parse_mode:"HTML",reply_markup:menu});
          return res.sendStatus(200);
        }
        return next();
      }

      if(cmd==="/start"||cmd==="/help"){
        await send({text:"🤖 <b>AI Opportunity Hub</b>\\n\\nJust tell me what you need. I can find AI tools, jobs, opportunities, Android AI, free resources and tutorials.\\n\\nExample: <i>free AI video tool for YouTube Shorts</i>",parse_mode:"HTML",reply_markup:menu});
        return res.sendStatus(200);
      }

      if(cmd==="/tools"||cmd==="/jobs"||cmd==="/free"||cmd==="/learn"){
        const type=cmd==="/free"?"resources":cmd==="/learn"?"tutorials":cmd.slice(1),p=await get(type,"");
        await send({text:format(p.title,p.items),parse_mode:"HTML",reply_markup:menu});
        return res.sendStatus(200);
      }

      if(text&&!text.startsWith("/")){
        const result=await answer(text);
        await send({text:result,parse_mode:"HTML",reply_markup:menu});
        if(user?.id)await pool.query("UPDATE hub_users SET search_count=search_count+1,last_active=CURRENT_TIMESTAMP WHERE telegram_id=$1",[user.id]);
        return res.sendStatus(200);
      }
      return next();
    }catch(e){
      console.error("Hub v2 webhook:",e.message);
      return next();
    }
  });

  app.get("/miniapp",async(req,res)=>res.type("html").send(miniAppHtml(process.env.PUBLIC_BASE_URL)));

  for(const type of ["tools","jobs","opportunities","resources","tutorials"]){
    app.get("/api/hub/"+type,async(req,res)=>{
      try{await ready();res.json(await get(type,req.query.q||""));}catch(e){res.status(500).json({error:e.message});}
    });
  }
  app.get("/api/hub/trending",async(req,res)=>{
    try{await ready();res.json(await get("trending",req.query.q||""));}catch(e){res.status(500).json({error:e.message});}
  });
  app.get("/api/hub/all",async(req,res)=>{
    try{await ready();res.json(await get("all",req.query.q||""));}catch(e){res.status(500).json({error:e.message});}
  });
  app.post("/api/hub/track",async(req,res)=>{
    try{
      await ready();
      const x=req.body||{};
      if(x.telegram_id)await pool.query("UPDATE hub_users SET last_active=CURRENT_TIMESTAMP,tool_clicks=tool_clicks+$1,job_clicks=job_clicks+$2 WHERE telegram_id=$3",[x.type==="tools"?1:0,x.type==="jobs"?1:0,x.telegram_id]);
      res.json({tracked:true});
    }catch(e){res.status(500).json({tracked:false,error:e.message});}
  });

  ready().catch(e=>console.error("Hub v2 schema:",e.message));
}
