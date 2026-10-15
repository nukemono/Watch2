(()=>{
  'use strict';
  const DB_NAME='solarwatch_iphone_field_v1', STORE='sessions';
  let cache=[];
  const finite=Number.isFinite;

  function magneticClass(azError){
    const a=Math.abs(azError);
    return a<5?'低':a<10?'注意':'強';
  }

  function openDb(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,1);
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE,{keyPath:'session_id'});
      };
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
  }

  async function getSessions(){
    const db=await openDb();
    const out=await new Promise((resolve,reject)=>{
      const req=db.transaction(STORE,'readonly').objectStore(STORE).getAll();
      req.onsuccess=()=>resolve(req.result||[]);
      req.onerror=()=>reject(req.error);
    });
    db.close();
    return out.sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));
  }

  function rowForCsv(session,sample){
    const r=session.result||{};
    const a=session.actual_sun||{};
    const q=session.quality||{};
    return {
      session_id:session.session_id,
      device_label:session.device_label,
      measurement_condition_id:session.condition_id,
      created_at:session.created_at,
      measurement_valid:q.valid!==false,
      measurement_invalid_reason:q.reason||'',
      measurement_ready_ratio:q.ready_ratio??null,
      measurement_quality_sample_count:q.sample_count??null,
      measurement_estimation_sample_count:q.estimation_sample_count??null,
      ...sample,
      mvp_observed_azimuth_deg:session.summary?.heading_mean_deg??null,
      mvp_observed_elevation_deg:session.summary?.elevation_mean_deg??null,
      mvp_heading_circular_sd_deg:session.summary?.heading_sd_deg??null,
      mvp_elevation_sd_deg:session.summary?.elevation_sd_deg??null,
      mvp_sample_count:session.summary?.sample_count??null,
      mvp_estimation_sample_count:session.summary?.estimation_sample_count??null,
      mvp_elevation_coordinate:session.summary?.elevation_coordinate??null,
      mvp_estimated_time_iso:r.estimated_time_iso??null,
      mvp_actual_time_iso:r.actual_time_iso??null,
      mvp_time_error_min:r.time_error_min??null,
      mvp_predicted_sun_azimuth_deg:r.predicted_sun_azimuth_deg??null,
      mvp_predicted_sun_elevation_deg:r.predicted_sun_elevation_deg??null,
      mvp_angular_residual_deg:r.angular_residual_deg??null,
      actual_sun_azimuth_deg:a.azimuth??null,
      actual_sun_elevation_deg:a.elevation??null,
      observation_azimuth_error_deg:session.sensor_validation?.azimuth_error_deg??null,
      observation_elevation_error_deg:session.sensor_validation?.elevation_error_deg??null,
      magnetic_effect_candidate:session.sensor_validation&&finite(session.sensor_validation.azimuth_error_deg)?magneticClass(session.sensor_validation.azimuth_error_deg):null
    };
  }

  function csvText(sessions){
    const rows=sessions.flatMap(s=>(s.samples||[]).map(x=>rowForCsv(s,x)));
    if(!rows.length) return '';
    const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
    const esc=v=>{
      if(v===null||v===undefined) return '';
      const s=String(v);
      return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
    };
    return keys.join(',')+'\n'+rows.map(r=>keys.map(k=>esc(r[k])).join(',')).join('\n');
  }

  async function copyFallback(text){
    if(navigator.clipboard&&navigator.clipboard.writeText){
      await navigator.clipboard.writeText(text);
      alert('CSVデータをクリップボードへコピーしました。共有先へ貼り付けてください。');
      return;
    }
    const ta=document.createElement('textarea');
    ta.value=text;
    ta.style.position='fixed';
    ta.style.opacity='0';
    document.body.appendChild(ta);
    ta.focus();ta.select();
    const ok=document.execCommand('copy');
    ta.remove();
    alert(ok?'CSVデータをクリップボードへコピーしました。共有先へ貼り付けてください。':'このブラウザでは直接共有できません。');
  }

  async function shareCsv(filename,text){
    if(!text) return alert('共有できる測定データがありません。');
    const file=new File([text],filename,{type:'text/csv;charset=utf-8'});
    try{
      if(navigator.share){
        const payload={title:'SolarWatch 測定データ',text:'SolarWatchの測定CSVです。',files:[file]};
        if(!navigator.canShare||navigator.canShare({files:[file]})){
          await navigator.share(payload);
          return;
        }
        await navigator.share({title:payload.title,text:text});
        return;
      }
      await copyFallback(text);
    }catch(e){
      if(e&&e.name==='AbortError') return;
      await copyFallback(text);
    }
  }

  function updateButtons(){
    const latest=document.getElementById('shareLatestBtn');
    const all=document.getElementById('shareAllBtn');
    if(latest) latest.disabled=!cache.length;
    if(all) all.disabled=!cache.length;
  }

  async function refresh(){
    try{ cache=await getSessions(); }
    catch(e){ console.warn('share-data: session load failed',e); cache=[]; }
    updateButtons();
  }

  function inject(){
    const download=document.getElementById('downloadBtn');
    if(download&&!document.getElementById('shareLatestBtn')){
      const b=document.createElement('button');
      b.id='shareLatestBtn';b.className='secondary';b.textContent='この測定データを共有';b.disabled=true;
      download.insertAdjacentElement('afterend',b);
      b.addEventListener('click',()=>{
        if(!cache.length) return alert('共有データを準備中です。少ししてからもう一度押してください。');
        const s=cache[0];
        shareCsv((s.session_id||'solarwatch_measurement')+'.csv',csvText([s]));
      });
    }

    const downloadAll=document.getElementById('downloadAllBtn');
    if(downloadAll&&!document.getElementById('shareAllBtn')){
      const b=document.createElement('button');
      b.id='shareAllBtn';b.className='secondary';b.textContent='保存済み全データを共有';b.disabled=true;
      downloadAll.insertAdjacentElement('afterend',b);
      b.addEventListener('click',()=>{
        if(!cache.length) return alert('保存データがありません。');
        shareCsv('solarwatch_field_all.csv',csvText(cache));
      });
    }

    const history=document.getElementById('history');
    if(history&&!history.dataset.shareObserved){
      history.dataset.shareObserved='1';
      new MutationObserver(()=>refresh()).observe(history,{childList:true,subtree:true,characterData:true});
    }
    refresh();
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',inject,{once:true});
  else inject();
})();
