(()=>{
  const rad=Math.PI/180,deg=180/Math.PI;
  const finite=Number.isFinite;
  const norm=v=>(v%360+360)%360;
  const cd=(a,b)=>((a-b+540)%360)-180;
  const DB_NAME='solarwatch_iphone_field_v1',STORE='sessions';
  const MIN_OBS=2,RECOMMENDED_OBS=3,MIN_SPAN_MIN=5,RECOMMENDED_SPAN_MIN=15;
  const GROUP_RADIUS_M=100,MAX_OBS=8,MAX_RESIDUAL_RMS=6;
  const SEARCH_MIN=-720,SEARCH_MAX=720;
  let pendingStart=0,processedId=null;

  const $=id=>document.getElementById(id);
  function openDb(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,1);
      req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'session_id'});};
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
  }
  async function getSessions(){
    const db=await openDb();
    const out=await new Promise((resolve,reject)=>{const r=db.transaction(STORE,'readonly').objectStore(STORE).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);});
    db.close();return out.sort((a,b)=>b.created_at.localeCompare(a.created_at));
  }
  async function putSession(session){
    const db=await openDb();
    await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(session);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
    db.close();
  }
  function circularMean(values){
    const a=values.filter(finite);if(!a.length)return null;
    let sx=0,sy=0;for(const v of a){sx+=Math.sin(v*rad);sy+=Math.cos(v*rad);}return norm(Math.atan2(sx,sy)*deg);
  }
  function signedCircularMean(values){const m=circularMean(values.map(norm));return finite(m)?cd(m,0):null;}
  function julianDay(date){return date.getTime()/86400000+2440587.5;}
  function sunPosition(date,latDeg,lonDeg){
    const jd=julianDay(date),T=(jd-2451545.0)/36525;
    let L0=norm(280.46646+T*(36000.76983+0.0003032*T));
    const M=norm(357.52911+T*(35999.05029-0.0001537*T));
    const e=0.016708634-T*(0.000042037+0.0000001267*T),Mr=M*rad;
    const C=Math.sin(Mr)*(1.914602-T*(0.004817+0.000014*T))+Math.sin(2*Mr)*(0.019993-0.000101*T)+Math.sin(3*Mr)*0.000289;
    const trueLong=L0+C,omega=125.04-1934.136*T,lambda=trueLong-0.00569-0.00478*Math.sin(omega*rad);
    const eps0=23+(26+(21.448-T*(46.815+T*(0.00059-T*0.001813)))/60)/60,eps=eps0+0.00256*Math.cos(omega*rad);
    const dec=Math.asin(Math.sin(eps*rad)*Math.sin(lambda*rad)),y=Math.tan((eps*rad)/2)**2;
    const eq=4*deg*(y*Math.sin(2*L0*rad)-2*e*Math.sin(Mr)+4*e*y*Math.sin(Mr)*Math.cos(2*L0*rad)-0.5*y*y*Math.sin(4*L0*rad)-1.25*e*e*Math.sin(2*Mr));
    const utcMin=date.getUTCHours()*60+date.getUTCMinutes()+date.getUTCSeconds()/60+date.getUTCMilliseconds()/60000;
    let tst=(utcMin+eq+4*lonDeg)%1440;if(tst<0)tst+=1440;let ha=tst/4-180;if(ha<-180)ha+=360;
    const lat=latDeg*rad,har=ha*rad,cosZ=Math.sin(lat)*Math.sin(dec)+Math.cos(lat)*Math.cos(dec)*Math.cos(har);
    const zen=Math.acos(Math.max(-1,Math.min(1,cosZ))),elev=90-zen*deg;
    const az=norm(Math.atan2(Math.sin(har),Math.cos(har)*Math.sin(lat)-Math.tan(dec)*Math.cos(lat))*deg+180);
    return {azimuth:az,elevation:elev};
  }
  function angularDistance(az1,el1,az2,el2){
    const a1=az1*rad,e1=el1*rad,a2=az2*rad,e2=el2*rad;
    const c=Math.sin(e1)*Math.sin(e2)+Math.cos(e1)*Math.cos(e2)*Math.cos(a1-a2);
    return Math.acos(Math.max(-1,Math.min(1,c)))*deg;
  }
  function obsTime(session){
    const ts=(session.samples||[]).map(s=>Date.parse(s.sample_time_iso)).filter(finite).sort((a,b)=>a-b);
    if(ts.length)return new Date((ts[0]+ts[ts.length-1])/2);
    const d=new Date(session.observation_time_iso||session.created_at);return Number.isNaN(d.getTime())?null:d;
  }
  function sameDay(a,b){return a&&b&&a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();}
  function distanceMeters(a,b){
    if(!a||!b||![a.lat,a.lon,b.lat,b.lon].every(finite))return Infinity;
    const p1=a.lat*rad,p2=b.lat*rad,dp=(b.lat-a.lat)*rad,dl=(b.lon-a.lon)*rad;
    const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
  }
  function groupSessions(all,current){
    const t0=obsTime(current),map=new Map();
    for(const s of all){
      if(!s||s.magnetic_bias_mode!==true||s.quality?.valid===false)continue;
      if(s.device_label!==current.device_label||s.condition_id!==current.condition_id)continue;
      if(!sameDay(obsTime(s),t0)||distanceMeters(s.location,current.location)>GROUP_RADIUS_M)continue;
      if(!finite(s.summary?.heading_mean_deg)||!finite(s.summary?.elevation_mean_deg))continue;
      map.set(s.session_id,s);
    }
    const arr=[...map.values()].sort((a,b)=>obsTime(a)-obsTime(b));
    if(arr.length<=MAX_OBS)return arr;
    const out=[];for(let i=0;i<MAX_OBS;i++)out.push(arr[Math.round(i*(arr.length-1)/(MAX_OBS-1))]);
    return [...new Map(out.map(x=>[x.session_id,x])).values()];
  }
  function evaluate(obs,offsetSec){
    const positions=[],biases=[];
    for(const o of obs){
      const t=new Date(o.time.getTime()+offsetSec*1000),sp=sunPosition(t,o.location.lat,o.location.lon);
      if(sp.elevation<-8)return null;positions.push({time:t,sun:sp});biases.push(cd(o.heading,sp.azimuth));
    }
    const bias=signedCircularMean(biases);if(!finite(bias))return null;
    const dists=[],azErr=[],elErr=[];
    for(let i=0;i<obs.length;i++){
      const corrected=norm(obs[i].heading-bias),sp=positions[i].sun;
      dists.push(angularDistance(corrected,obs[i].elevation,sp.azimuth,sp.elevation));
      azErr.push(cd(corrected,sp.azimuth));elErr.push(obs[i].elevation-sp.elevation);
    }
    const rms=a=>Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);
    return {offsetSec,bias,score:rms(dists),azimuthRms:rms(azErr),elevationRms:rms(elErr),positions};
  }
  function estimate(all,current){
    const group=groupSessions(all,current);
    const obs=group.map(s=>({id:s.session_id,time:obsTime(s),location:s.location,heading:s.summary.heading_mean_deg,elevation:s.summary.elevation_mean_deg})).filter(x=>x.time&&finite(x.heading)&&finite(x.elevation));
    const span=obs.length>1?(obs[obs.length-1].time-obs[0].time)/60000:0;
    if(obs.length<MIN_OBS)return {status:'pending',observation_count:obs.length,observation_span_min:span,needed:MIN_OBS-obs.length};
    if(span<MIN_SPAN_MIN)return {status:'pending_span',observation_count:obs.length,observation_span_min:span,needed_span_min:MIN_SPAN_MIN-span};
    let best=null;
    for(let minute=SEARCH_MIN;minute<=SEARCH_MAX;minute++){const e=evaluate(obs,minute*60);if(e&&(!best||e.score<best.score))best=e;}
    if(!best)return {status:'failed',observation_count:obs.length,observation_span_min:span};
    for(let sec=best.offsetSec-90;sec<=best.offsetSec+90;sec++){const e=evaluate(obs,sec);if(e&&e.score<best.score)best=e;}
    const idx=Math.max(0,obs.findIndex(o=>o.id===current.session_id)),cp=best.positions[idx];
    const confidence=best.score<=MAX_RESIDUAL_RMS?(obs.length>=RECOMMENDED_OBS&&span>=RECOMMENDED_SPAN_MIN?'good':'provisional'):'low';
    return {status:'estimated',confidence,observation_count:obs.length,observation_span_min:span,magnetic_bias_deg:best.bias,clock_offset_min:best.offsetSec/60,residual_rms_deg:best.score,azimuth_rms_deg:best.azimuthRms,elevation_rms_deg:best.elevationRms,current_estimated_time_iso:cp.time.toISOString(),current_predicted_sun_azimuth_deg:cp.sun.azimuth,current_predicted_sun_elevation_deg:cp.sun.elevation,current_corrected_heading_deg:norm(current.summary.heading_mean_deg-best.bias),session_ids:obs.map(o=>o.id)};
  }
  function injectUi(){
    const conditionCard=document.querySelectorAll('.card')[1],row=conditionCard?.querySelector('.row');
    if(!$('biasMode')&&row){
      const box=document.createElement('div');box.className='notice';box.style.marginTop='10px';
      box.innerHTML='<label style="display:flex;align-items:center;gap:8px;font-weight:800"><input id="biasMode" type="checkbox" style="width:auto;transform:scale(1.25)"> 磁気バイアス推定モード</label><div id="biasModeStatus" class="muted" style="margin-top:6px">OFF：従来の1回観測推定</div>';
      row.insertAdjacentElement('afterend',box);
    }
    const grid=$('resultCard')?.querySelector('.grid');
    if(grid&&!$('biasValue')){
      const html='<div class="metric"><div class="label">推定モード</div><div id="estimateMode" class="value">--</div></div><div class="metric"><div class="label">推定磁気バイアス</div><div id="biasValue" class="value">--</div></div><div class="metric"><div class="label">バイアス観測数 / 時間幅</div><div id="biasObservationCount" class="value">--</div></div><div class="metric"><div class="label">時計補正量</div><div id="biasClockOffset" class="value">--</div></div>';
      grid.insertAdjacentHTML('beforeend',html);
    }
    if($('biasMode')&&!$('biasMode').dataset.bound){
      $('biasMode').checked=false;
      $('biasMode').dataset.bound='1';
      $('biasMode').addEventListener('change',refreshStatus);
    }
    if($('recordBtn')&&!$('recordBtn').dataset.biasBound){
      $('recordBtn').dataset.biasBound='1';
      $('recordBtn').addEventListener('click',()=>{pendingStart=Date.now();processedId=null;});
    }
  }
  async function refreshStatus(){
    if(!$('biasModeStatus'))return;
    const on=$('biasMode').checked;
    if(!on){$('biasModeStatus').textContent='OFF：従来の1回観測推定';return;}
    const all=await getSessions();
    const dev=$('deviceLabel')?.value||'iPhone',cond=$('conditionId')?.value||'I1';
    const count=all.filter(s=>s.magnetic_bias_mode===true&&s.quality?.valid!==false&&s.device_label===dev&&s.condition_id===cond).length;
    $('biasModeStatus').textContent=`ON：保存済み対象 ${count}件。最低2回・5分以上、推奨3回・15分以上。`;
  }
  function applyResultUi(s){
    const b=s.bias_estimation,r=s.result;
    if($('estimateMode'))$('estimateMode').textContent=s.magnetic_bias_mode?'磁気バイアス推定':'1回観測';
    if($('biasValue'))$('biasValue').textContent=b&&finite(b.magnetic_bias_deg)?`${b.magnetic_bias_deg>=0?'+':''}${b.magnetic_bias_deg.toFixed(1)}°`:'--';
    if($('biasObservationCount'))$('biasObservationCount').textContent=b?`${b.observation_count??0}回 / ${finite(b.observation_span_min)?b.observation_span_min.toFixed(1):'--'}分`:'--';
    if($('biasClockOffset'))$('biasClockOffset').textContent=b&&finite(b.clock_offset_min)?`${b.clock_offset_min>=0?'+':''}${b.clock_offset_min.toFixed(1)}分`:'--';
    if(!s.magnetic_bias_mode)return;
    if(b?.status==='estimated'&&b.confidence!=='low'&&r){
      $('estimatedTime').textContent=new Date(r.estimated_time_iso).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      $('timeError').textContent=(r.time_error_min>=0?'+':'')+r.time_error_min.toFixed(1)+'分';$('residual').textContent=b.residual_rms_deg.toFixed(1)+'°';
      $('resultDetail').textContent=`${b.observation_count}回・${b.observation_span_min.toFixed(1)}分の観測から共通磁気バイアス ${b.magnetic_bias_deg>=0?'+':''}${b.magnetic_bias_deg.toFixed(1)}°を推定しました。残差RMS ${b.residual_rms_deg.toFixed(1)}°、信頼度 ${b.confidence==='good'?'良好':'暫定'}。`;
    }else{
      if(r){
        $('estimatedTime').textContent=new Date(r.estimated_time_iso).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        $('timeError').textContent=(r.time_error_min>=0?'+':'')+r.time_error_min.toFixed(1)+'分';
        if(Number.isFinite(r.angular_residual_deg))$('residual').textContent=r.angular_residual_deg.toFixed(1)+'°';
      }else{
        $('estimatedTime').textContent='--';$('timeError').textContent='--';
      }
      if(b?.status==='pending')$('resultDetail').textContent=`磁気バイアス推定はあと${b.needed}回必要です。現在は従来の1回観測による推定時刻を暫定表示しています。`;
      else if(b?.status==='pending_span')$('resultDetail').textContent=`観測は${b.observation_count}回ありますが時間幅が${b.observation_span_min.toFixed(1)}分です。あと${b.needed_span_min.toFixed(1)}分以上空けてください。現在は1回観測の推定値を暫定表示しています。`;
      else if(b?.confidence==='low')$('resultDetail').textContent=`磁気バイアスは推定できましたが残差RMS ${b.residual_rms_deg.toFixed(1)}°が大きいため補正を採用せず、1回観測の推定値を表示しています。`;
    }
  }
  async function processLatest(){
    if(!$('biasMode')?.checked||!pendingStart)return;
    const all=await getSessions();if(!all.length)return;
    const latest=all[0],created=Date.parse(latest.created_at);
    if(!finite(created)||created<pendingStart-5000||latest.session_id===processedId)return;
    processedId=latest.session_id;latest.magnetic_bias_mode=true;latest.observation_time_iso=obsTime(latest)?.toISOString()||latest.created_at;
    if(latest.result&&!latest.single_observation_result){
      latest.single_observation_result={...latest.result,estimation_method:'single_observation'};
    }
    const withCurrent=[latest,...all.slice(1)];
    const b=estimate(withCurrent,latest);latest.bias_estimation=b;
    if(b.status==='estimated'&&b.confidence!=='low'){
      const estTime=new Date(b.current_estimated_time_iso),actual=obsTime(latest);
      latest.result={estimated_time_iso:estTime.toISOString(),actual_time_iso:actual.toISOString(),time_error_min:(estTime-actual)/60000,predicted_sun_azimuth_deg:b.current_predicted_sun_azimuth_deg,predicted_sun_elevation_deg:b.current_predicted_sun_elevation_deg,angular_residual_deg:b.residual_rms_deg,estimation_method:'magnetic_bias_multi_observation',magnetic_bias_deg:b.magnetic_bias_deg,observation_count:b.observation_count};
    }else{
      latest.result=latest.single_observation_result||latest.result||null;
    }
    await putSession(latest);applyResultUi(latest);await refreshStatus();
  }
  function csvEscape(v){if(v===null||v===undefined)return '';const s=String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
  function csvText(sessions){
    const rows=sessions.flatMap(s=>(s.samples||[]).map(sample=>({session_id:s.session_id,device_label:s.device_label,measurement_condition_id:s.condition_id,created_at:s.created_at,observation_time_iso:s.observation_time_iso??null,magnetic_bias_mode:s.magnetic_bias_mode===true,measurement_valid:s.quality?.valid!==false,measurement_invalid_reason:s.quality?.reason||'',...sample,mvp_observed_azimuth_deg:s.summary?.heading_mean_deg??null,mvp_observed_elevation_deg:s.summary?.elevation_mean_deg??null,mvp_heading_circular_sd_deg:s.summary?.heading_sd_deg??null,mvp_elevation_sd_deg:s.summary?.elevation_sd_deg??null,mvp_sample_count:s.summary?.sample_count??null,mvp_estimated_time_iso:s.result?.estimated_time_iso??null,mvp_actual_time_iso:s.result?.actual_time_iso??null,mvp_time_error_min:s.result?.time_error_min??null,mvp_predicted_sun_azimuth_deg:s.result?.predicted_sun_azimuth_deg??null,mvp_predicted_sun_elevation_deg:s.result?.predicted_sun_elevation_deg??null,mvp_angular_residual_deg:s.result?.angular_residual_deg??null,estimation_method:s.result?.estimation_method??(s.magnetic_bias_mode?'magnetic_bias_multi_observation':'single_observation'),bias_estimation_status:s.bias_estimation?.status??null,bias_estimation_confidence:s.bias_estimation?.confidence??null,bias_observation_count:s.bias_estimation?.observation_count??null,bias_observation_span_min:s.bias_estimation?.observation_span_min??null,estimated_magnetic_bias_deg:s.bias_estimation?.magnetic_bias_deg??null,bias_clock_offset_min:s.bias_estimation?.clock_offset_min??null,bias_residual_rms_deg:s.bias_estimation?.residual_rms_deg??null,bias_azimuth_rms_deg:s.bias_estimation?.azimuth_rms_deg??null,bias_elevation_rms_deg:s.bias_estimation?.elevation_rms_deg??null,bias_corrected_observed_azimuth_deg:s.bias_estimation?.current_corrected_heading_deg??null})));
    if(!rows.length)return '';const keys=Object.keys(rows[0]);return keys.join(',')+'\n'+rows.map(r=>keys.map(k=>csvEscape(r[k])).join(',')).join('\n');
  }
  function download(name,text){const blob=new Blob([text],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function overrideDownloads(){
    if($('downloadBtn'))$('downloadBtn').onclick=async()=>{const s=(await getSessions())[0];if(s)download(s.session_id+'.csv',csvText([s]));};
    if($('downloadAllBtn'))$('downloadAllBtn').onclick=async()=>{const ss=await getSessions();if(!ss.length)return alert('保存データがありません');download('solarwatch_iphone_field_all.csv',csvText(ss));};
  }
  function keepUiFresh(){
    if($('biasMode')?.checked&&$('recordBtn')&&!$('recordBtn').disabled&&!document.getElementById('recordingBox')?.classList.contains('hidden'))return;
    if($('biasMode')?.checked&&$('recordBtn')&&!document.getElementById('recordingBox')?.classList.contains('hidden'))$('recordBtn').textContent='10秒測定 ＋ 磁気バイアス推定';
  }
  function init(){
    injectUi();overrideDownloads();refreshStatus();
    new MutationObserver(()=>{if(!$('resultCard')?.classList.contains('hidden'))setTimeout(processLatest,50);}).observe($('resultCard'),{attributes:true,attributeFilter:['class']});
    setInterval(()=>{if($('biasMode')?.checked&&$('recordBtn')&&!$('recordingBox')?.classList.contains('hidden'))$('recordBtn').textContent='10秒測定 ＋ 磁気バイアス推定';},500);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
