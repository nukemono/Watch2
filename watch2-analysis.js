(()=>{
  'use strict';

  const DB_NAME='solarwatch_iphone_field_v1', STORE='sessions';
  const MAX_AZ_ERROR_DEG=30;
  const MAX_EL_ERROR_DEG=20;
  const MAX_RESIDUAL_DEG=20;
  const ELEVATION_PRIORITY_AZ_WEIGHT=0.15;
  const rad=Math.PI/180, deg=180/Math.PI;
  const finite=Number.isFinite;
  const norm=v=>(v%360+360)%360;
  const cd=(a,b)=>((a-b+540)%360)-180;
  let processedId=null;
  let processTimer=null;

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

  async function putSession(session){
    const db=await openDb();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite');
      tx.objectStore(STORE).put(session);
      tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error);
    });
    db.close();
  }

  function circularStats(values){
    const a=values.filter(finite);
    if(!a.length) return {mean:null,sd:null};
    let sx=0,sy=0;
    for(const v of a){sx+=Math.sin(v*rad);sy+=Math.cos(v*rad);}
    const mean=norm(Math.atan2(sx,sy)*deg);
    const R=Math.hypot(sx,sy)/a.length;
    const sd=R>0?Math.sqrt(Math.max(0,-2*Math.log(Math.min(1,R))))*deg:180;
    return {mean,sd};
  }

  function mean(values){
    const a=values.filter(finite);
    return a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
  }

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
    let tst=(utcMin+eq+4*lonDeg)%1440;if(tst<0)tst+=1440;
    let ha=tst/4-180;if(ha<-180)ha+=360;
    const lat=latDeg*rad,har=ha*rad;
    const cosZ=Math.sin(lat)*Math.sin(dec)+Math.cos(lat)*Math.cos(dec)*Math.cos(har);
    const zen=Math.acos(Math.max(-1,Math.min(1,cosZ))),elev=90-zen*deg;
    const az=norm(Math.atan2(Math.sin(har),Math.cos(har)*Math.sin(lat)-Math.tan(dec)*Math.cos(lat))*deg+180);
    return {azimuth:az,elevation:elev};
  }

  function angularDistance(az1,el1,az2,el2){
    const a1=az1*rad,e1=el1*rad,a2=az2*rad,e2=el2*rad;
    const c=Math.sin(e1)*Math.sin(e2)+Math.cos(e1)*Math.cos(e2)*Math.cos(a1-a2);
    return Math.acos(Math.max(-1,Math.min(1,c)))*deg;
  }

  function acceptable(obsAz,obsEl,sun){
    return Math.abs(cd(obsAz,sun.azimuth))<=MAX_AZ_ERROR_DEG&&Math.abs(obsEl-sun.elevation)<=MAX_EL_ERROR_DEG;
  }

  function estimateGeometric(obsAz,obsEl,when,lat,lon){
    if(!finite(obsAz)||!finite(obsEl)||obsEl<-90||obsEl>90)return null;
    const y=when.getFullYear(),m=when.getMonth(),d=when.getDate();
    let best=null;
    for(let minute=0;minute<1440;minute++){
      const t=new Date(y,m,d,0,minute,0,0),s=sunPosition(t,lat,lon);
      if(s.elevation<-8||!acceptable(obsAz,obsEl,s))continue;
      const dist=angularDistance(obsAz,obsEl,s.azimuth,s.elevation);
      if(!best||dist<best.dist)best={time:t,sun:s,dist};
    }
    if(!best)return null;
    let fine=best;
    for(let sec=-90;sec<=90;sec++){
      const t=new Date(best.time.getTime()+sec*1000),s=sunPosition(t,lat,lon);
      if(!acceptable(obsAz,obsEl,s))continue;
      const dist=angularDistance(obsAz,obsEl,s.azimuth,s.elevation);
      if(dist<fine.dist)fine={time:t,sun:s,dist};
    }
    return fine.dist<=MAX_RESIDUAL_DEG?fine:null;
  }

  function elevationPriorityScore(obsAz,obsEl,sun){
    const azDiff=Math.abs(cd(obsAz,sun.azimuth));
    const elDiff=Math.abs(obsEl-sun.elevation);
    return {score:elDiff+azDiff*ELEVATION_PRIORITY_AZ_WEIGHT,azDiff,elDiff};
  }

  function estimateElevationPriority(obsAz,obsEl,when,lat,lon){
    if(!finite(obsAz)||!finite(obsEl)||obsEl<-90||obsEl>90)return null;
    const y=when.getFullYear(),m=when.getMonth(),d=when.getDate();
    let best=null;
    for(let minute=0;minute<1440;minute++){
      const t=new Date(y,m,d,0,minute,0,0),s=sunPosition(t,lat,lon);
      if(s.elevation<-8||!acceptable(obsAz,obsEl,s))continue;
      const sc=elevationPriorityScore(obsAz,obsEl,s);
      const dist=angularDistance(obsAz,obsEl,s.azimuth,s.elevation);
      if(!best||sc.score<best.score)best={time:t,sun:s,dist,...sc};
    }
    if(!best)return null;
    let fine=best;
    for(let sec=-90;sec<=90;sec++){
      const t=new Date(best.time.getTime()+sec*1000),s=sunPosition(t,lat,lon);
      if(!acceptable(obsAz,obsEl,s))continue;
      const sc=elevationPriorityScore(obsAz,obsEl,s);
      const dist=angularDistance(obsAz,obsEl,s.azimuth,s.elevation);
      if(sc.score<fine.score)fine={time:t,sun:s,dist,...sc};
    }
    return fine.dist<=MAX_RESIDUAL_DEG?fine:null;
  }

  function minutesBetween(a,b){return (a.getTime()-b.getTime())/60000;}
  function fmt(v,d=1,s='°'){return finite(v)?v.toFixed(d)+s:'--';}
  function signed(v,d=1,s='°'){return finite(v)?(v>=0?'+':'')+v.toFixed(d)+s:'--';}
  function timeText(iso){
    if(!iso)return '--';
    const d=new Date(iso);if(Number.isNaN(d.getTime()))return '--';
    return d.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }

  function stageSummary(session){
    const samples=session.samples||[];
    const raw=circularStats(samples.map(s=>s.camera3d_raw_heading_deg));
    const anchor=circularStats(samples.map(s=>s.camera_heading_before_wmm_deg));
    const final=circularStats(samples.map(s=>s.ios_heading_corrected_deg));
    const rawPlusWmm=circularStats(samples.map(s=>finite(s.camera3d_raw_heading_deg)&&finite(s.wmm_declination_deg)?norm(s.camera3d_raw_heading_deg+s.wmm_declination_deg):null));
    const declination=mean(samples.map(s=>s.wmm_declination_deg));
    return {raw,rawPlusWmm,anchor,final,declination};
  }

  function buildAnalysis(session){
    const loc=session.location||{};
    const obsAz=session.summary?.heading_mean_deg;
    const obsEl=session.summary?.elevation_mean_deg;
    const actualIso=session.result?.actual_time_iso||session.created_at;
    const actual=new Date(actualIso);
    if(!finite(loc.lat)||!finite(loc.lon)||!finite(obsAz)||!finite(obsEl)||Number.isNaN(actual.getTime()))return null;

    const actualSun=session.actual_sun&&finite(session.actual_sun.azimuth)&&finite(session.actual_sun.elevation)
      ?session.actual_sun
      :sunPosition(actual,loc.lat,loc.lon);
    const primary=estimateGeometric(obsAz,obsEl,actual,loc.lat,loc.lon);
    const elevationPriority=estimateElevationPriority(obsAz,obsEl,actual,loc.lat,loc.lon);
    const stages=stageSummary(session);
    const rawWmmEstimate=finite(stages.rawPlusWmm.mean)?estimateGeometric(stages.rawPlusWmm.mean,obsEl,actual,loc.lat,loc.lon):null;

    const rawPlusWmmError=finite(stages.rawPlusWmm.mean)?cd(stages.rawPlusWmm.mean,actualSun.azimuth):null;
    const finalError=finite(stages.final.mean)?cd(stages.final.mean,actualSun.azimuth):null;
    const anchorEffect=finite(rawPlusWmmError)&&finite(finalError)?Math.abs(finalError)-Math.abs(rawPlusWmmError):null;
    const elevationError=finite(obsEl)?obsEl-actualSun.elevation:null;
    const primaryError=primary?minutesBetween(primary.time,actual):null;
    const altError=elevationPriority?minutesBetween(elevationPriority.time,actual):null;
    const rawWmmTimeError=rawWmmEstimate?minutesBetween(rawWmmEstimate.time,actual):null;
    const estimatorDelta=primary&&elevationPriority?minutesBetween(elevationPriority.time,primary.time):null;

    const reasons=[];
    if(finite(elevationError)){
      if(Math.abs(elevationError)<=5)reasons.push(`canonical高度は実太陽高度との差 ${signed(elevationError)} で良好`);
      else reasons.push(`canonical高度差が ${signed(elevationError)} と大きい`);
    }
    if(finite(anchorEffect)){
      if(anchorEffect>3)reasons.push(`anchor適用後に方位絶対誤差が ${anchorEffect.toFixed(1)}° 増加`);
      else if(anchorEffect<-3)reasons.push(`anchor適用で方位絶対誤差が ${Math.abs(anchorEffect).toFixed(1)}° 改善`);
      else reasons.push(`anchor前後の方位絶対誤差差は ${Math.abs(anchorEffect).toFixed(1)}° と小さい`);
    }
    if(finite(estimatorDelta))reasons.push(`幾何推定と高度重視比較推定の差は ${Math.abs(estimatorDelta).toFixed(1)}分`);
    if(finite(finalError)&&Math.abs(finalError)>10)reasons.push(`残る主な観測誤差は最終方位 ${signed(finalError)}`);

    return {
      version:'watch2_explainability_v1',
      validation_only_actual_time_used_for_diagnostics:true,
      primary_method:'geometric_angular_distance_with_gates',
      comparison_method:'elevation_priority_with_same_gates',
      comparison_azimuth_weight:ELEVATION_PRIORITY_AZ_WEIGHT,
      limits:{azimuth_deg:MAX_AZ_ERROR_DEG,elevation_deg:MAX_EL_ERROR_DEG,residual_deg:MAX_RESIDUAL_DEG},
      observed:{azimuth_deg:obsAz,elevation_deg:obsEl},
      actual_sun:{azimuth_deg:actualSun.azimuth,elevation_deg:actualSun.elevation},
      stage_heading:{
        camera3d_raw_deg:stages.raw.mean,
        wmm_declination_deg:stages.declination,
        camera3d_raw_plus_wmm_deg:stages.rawPlusWmm.mean,
        anchor_before_wmm_deg:stages.anchor.mean,
        final_true_heading_deg:stages.final.mean,
        raw_plus_wmm_azimuth_error_deg:rawPlusWmmError,
        final_azimuth_error_deg:finalError,
        anchor_effect_abs_error_deg:anchorEffect
      },
      primary_estimate:primary?{
        estimated_time_iso:primary.time.toISOString(),
        time_error_min_validation:primaryError,
        angular_residual_deg:primary.dist,
        predicted_azimuth_deg:primary.sun.azimuth,
        predicted_elevation_deg:primary.sun.elevation
      }:null,
      elevation_priority_estimate:elevationPriority?{
        estimated_time_iso:elevationPriority.time.toISOString(),
        time_error_min_validation:altError,
        angular_residual_deg:elevationPriority.dist,
        score:elevationPriority.score,
        azimuth_error_deg:elevationPriority.azDiff,
        elevation_error_deg:elevationPriority.elDiff,
        predicted_azimuth_deg:elevationPriority.sun.azimuth,
        predicted_elevation_deg:elevationPriority.sun.elevation
      }:null,
      raw_camera_plus_wmm_estimate:rawWmmEstimate?{
        estimated_time_iso:rawWmmEstimate.time.toISOString(),
        time_error_min_validation:rawWmmTimeError,
        angular_residual_deg:rawWmmEstimate.dist
      }:null,
      estimator_time_difference_min:estimatorDelta,
      observed_elevation_error_deg_validation:elevationError,
      explanation:reasons.join(' / ')
    };
  }

  function attachCsvFields(session,analysis){
    for(const sample of session.samples||[]){
      sample.watch2_analysis_version=analysis.version;
      sample.watch2_primary_method=analysis.primary_method;
      sample.watch2_comparison_method=analysis.comparison_method;
      sample.watch2_comparison_azimuth_weight=analysis.comparison_azimuth_weight;
      sample.watch2_camera3d_raw_mean_deg=analysis.stage_heading.camera3d_raw_deg;
      sample.watch2_camera3d_raw_plus_wmm_mean_deg=analysis.stage_heading.camera3d_raw_plus_wmm_deg;
      sample.watch2_anchor_before_wmm_mean_deg=analysis.stage_heading.anchor_before_wmm_deg;
      sample.watch2_final_heading_mean_deg=analysis.stage_heading.final_true_heading_deg;
      sample.watch2_raw_plus_wmm_az_error_deg_validation=analysis.stage_heading.raw_plus_wmm_azimuth_error_deg;
      sample.watch2_final_az_error_deg_validation=analysis.stage_heading.final_azimuth_error_deg;
      sample.watch2_anchor_effect_abs_error_deg_validation=analysis.stage_heading.anchor_effect_abs_error_deg;
      sample.watch2_primary_estimated_time_iso=analysis.primary_estimate?.estimated_time_iso??null;
      sample.watch2_primary_time_error_min_validation=analysis.primary_estimate?.time_error_min_validation??null;
      sample.watch2_primary_residual_deg=analysis.primary_estimate?.angular_residual_deg??null;
      sample.watch2_elevation_priority_estimated_time_iso=analysis.elevation_priority_estimate?.estimated_time_iso??null;
      sample.watch2_elevation_priority_time_error_min_validation=analysis.elevation_priority_estimate?.time_error_min_validation??null;
      sample.watch2_elevation_priority_residual_deg=analysis.elevation_priority_estimate?.angular_residual_deg??null;
      sample.watch2_elevation_priority_score=analysis.elevation_priority_estimate?.score??null;
      sample.watch2_raw_plus_wmm_estimated_time_iso=analysis.raw_camera_plus_wmm_estimate?.estimated_time_iso??null;
      sample.watch2_raw_plus_wmm_time_error_min_validation=analysis.raw_camera_plus_wmm_estimate?.time_error_min_validation??null;
      sample.watch2_estimator_time_difference_min=analysis.estimator_time_difference_min;
      sample.watch2_observed_elevation_error_deg_validation=analysis.observed_elevation_error_deg_validation;
      sample.watch2_explanation=analysis.explanation;
    }
  }

  function injectPanel(){
    const resultCard=document.getElementById('resultCard');
    if(!resultCard||document.getElementById('watch2AnalysisPanel'))return;
    const detail=document.getElementById('resultDetail');
    const panel=document.createElement('div');
    panel.id='watch2AnalysisPanel';
    panel.className='notice';
    panel.style.marginTop='10px';
    panel.innerHTML='<strong>Watch2 説明可能性解析</strong><div id="watch2AnalysisBody" class="muted" style="margin-top:6px;line-height:1.6">測定後に解析します。</div>';
    if(detail)detail.insertAdjacentElement('afterend',panel);else resultCard.appendChild(panel);
  }

  function renderAnalysis(analysis){
    injectPanel();
    const body=document.getElementById('watch2AnalysisBody');
    if(!body||!analysis)return;
    const p=analysis.primary_estimate,a=analysis.elevation_priority_estimate,s=analysis.stage_heading;
    const rows=[
      `基準推定: ${p?timeText(p.estimated_time_iso):'不成立'} / 検証誤差 ${p?signed(p.time_error_min_validation,1,'分'):'--'} / 残差 ${p?fmt(p.angular_residual_deg):'--'}`,
      `比較推定（高度重視・安全ゲート維持）: ${a?timeText(a.estimated_time_iso):'不成立'} / 検証誤差 ${a?signed(a.time_error_min_validation,1,'分'):'--'} / 残差 ${a?fmt(a.angular_residual_deg):'--'}`,
      `方位診断: raw+WMM ${fmt(s.camera3d_raw_plus_wmm_deg)} → anchor+WMM ${fmt(s.final_true_heading_deg)} / 実太陽との差 ${signed(s.raw_plus_wmm_azimuth_error_deg)} → ${signed(s.final_azimuth_error_deg)}`,
      `高度診断: 実太陽との差 ${signed(analysis.observed_elevation_error_deg_validation)}`,
      `判定材料: ${analysis.explanation||'十分な診断値がありません'}`,
      '※「検証誤差」「実太陽との差」は端末の実時刻を使う検証専用値で、時刻推定の入力には使っていません。'
    ];
    body.innerHTML=rows.map(x=>`<div>${x}</div>`).join('');
  }

  function nudgeShareRefresh(){
    const h=document.getElementById('history');
    if(!h)return;
    const marker=document.createComment('watch2-analysis-updated');
    h.appendChild(marker);marker.remove();
  }

  async function processLatest(){
    try{
      const sessions=await getSessions();
      if(!sessions.length)return;
      const session=sessions[0];
      if(session.session_id===processedId&&session.watch2_analysis){renderAnalysis(session.watch2_analysis);return;}
      const analysis=buildAnalysis(session);
      if(!analysis)return;
      session.watch2_analysis=analysis;
      attachCsvFields(session,analysis);
      await putSession(session);
      processedId=session.session_id;
      renderAnalysis(analysis);
      nudgeShareRefresh();
    }catch(e){
      console.warn('watch2-analysis failed',e);
      injectPanel();
      const body=document.getElementById('watch2AnalysisBody');
      if(body)body.textContent='解析エラー: '+String(e&&e.message||e);
    }
  }

  function scheduleProcess(){
    clearTimeout(processTimer);
    processTimer=setTimeout(processLatest,650);
  }

  function init(){
    injectPanel();
    const resultCard=document.getElementById('resultCard');
    if(resultCard&&!resultCard.dataset.watch2AnalysisObserved){
      resultCard.dataset.watch2AnalysisObserved='1';
      new MutationObserver(()=>{
        if(!resultCard.classList.contains('hidden'))scheduleProcess();
      }).observe(resultCard,{attributes:true,attributeFilter:['class']});
    }
    if(resultCard&&!resultCard.classList.contains('hidden'))scheduleProcess();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();