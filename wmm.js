(function(global){
  'use strict';

  const MAX_DEGREE=12;
  const SIZE=MAX_DEGREE+1;
  const WGS84_A_KM=6378.137;
  const WGS84_B_KM=6356.7523142;
  const WMM_REFERENCE_RADIUS_KM=6371.2;
  const DEG_TO_RAD=Math.PI/180;

  const state={
    loaded:false,
    error:null,
    epoch:null,
    model:'',
    releaseDate:'',
    c:null,
    cd:null,
    k:null,
    fn:null,
    fm:null
  };

  const matrix=()=>Array.from({length:SIZE},()=>Array(SIZE).fill(0));

  function decimalYear(date){
    const d=date instanceof Date?date:new Date(date);
    if(Number.isNaN(d.getTime()))throw new Error('WMM: invalid date');
    const start=Date.UTC(d.getUTCFullYear(),0,1);
    const end=Date.UTC(d.getUTCFullYear()+1,0,1);
    return d.getUTCFullYear()+(d.getTime()-start)/(end-start);
  }

  function parseCoefficientFile(text){
    const lines=String(text).split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    if(!lines.length)throw new Error('WMM.COF is empty');
    const header=lines[0].split(/\s+/);
    const epoch=Number(header[0]);
    if(!Number.isFinite(epoch))throw new Error('WMM.COF epoch is invalid');

    const c=matrix(),cd=matrix(),snorm=Array(SIZE*SIZE).fill(0),k=matrix();
    const fn=Array(SIZE).fill(0),fm=Array(SIZE).fill(0);
    c[0][0]=0;cd[0][0]=0;snorm[0]=1;fm[0]=0;

    for(const line of lines.slice(1)){
      if(line.startsWith('9999'))break;
      const parts=line.split(/\s+/);
      if(parts.length<6)continue;
      const n=Number(parts[0]),m=Number(parts[1]);
      const g=Number(parts[2]),h=Number(parts[3]),dg=Number(parts[4]),dh=Number(parts[5]);
      if(![n,m,g,h,dg,dh].every(Number.isFinite)||n<1||n>MAX_DEGREE||m<0||m>n)continue;
      c[m][n]=g;cd[m][n]=dg;
      if(m!==0){c[n][m-1]=h;cd[n][m-1]=dh;}
    }

    // NOAA WMMの合成計算と同じく、係数を非正規化して内部計算する。
    for(let n=1;n<=MAX_DEGREE;n++){
      snorm[n]=snorm[n-1]*(2*n-1)/n;
      let j=2;
      for(let m=0;m<=n;m++){
        k[m][n]=(((n-1)*(n-1))-(m*m))/((2*n-1)*(2*n-3));
        if(m>0){
          const factor=((n-m+1)*j)/(n+m);
          snorm[n+m*SIZE]=snorm[n+(m-1)*SIZE]*Math.sqrt(factor);
          j=1;
          c[n][m-1]=snorm[n+m*SIZE]*c[n][m-1];
          cd[n][m-1]=snorm[n+m*SIZE]*cd[n][m-1];
        }
        c[m][n]=snorm[n+m*SIZE]*c[m][n];
        cd[m][n]=snorm[n+m*SIZE]*cd[m][n];
      }
      fn[n]=n+1;
      fm[n]=n;
    }
    k[1][1]=0;

    return {epoch,model:header[1]||'WMM',releaseDate:header[2]||'',c,cd,k,fn,fm};
  }

  async function load(url='./WMM.COF'){
    try{
      const response=await fetch(url,{cache:'no-store'});
      if(!response.ok)throw new Error('WMM.COF load failed: '+response.status);
      const parsed=parseCoefficientFile(await response.text());
      Object.assign(state,parsed,{loaded:true,error:null});
      return api;
    }catch(error){
      state.loaded=false;
      state.error=error;
      throw error;
    }
  }

  function calculate(latitudeDeg,longitudeDeg,altitudeMeters=0,date=new Date()){
    if(!state.loaded)throw new Error('WMM coefficients are not loaded');
    if(!Number.isFinite(latitudeDeg)||latitudeDeg<-90||latitudeDeg>90)throw new Error('WMM latitude out of range');
    if(!Number.isFinite(longitudeDeg))throw new Error('WMM longitude is invalid');

    const altitudeKm=Number.isFinite(altitudeMeters)?altitudeMeters/1000:0;
    const time=decimalYear(date);
    if(time<state.epoch||time>state.epoch+5)throw new Error('WMM date outside model validity window');

    const a=WGS84_A_KM,b=WGS84_B_KM,re=WMM_REFERENCE_RADIUS_KM;
    const a2=a*a,b2=b*b,c2=a2-b2,a4=a2*a2,b4=b2*b2,c4=a4-b4;
    const rlat=latitudeDeg*DEG_TO_RAD,rlon=longitudeDeg*DEG_TO_RAD;
    const srlon=Math.sin(rlon),crlon=Math.cos(rlon),srlat=Math.sin(rlat),crlat=Math.cos(rlat);
    const srlat2=srlat*srlat,crlat2=crlat*crlat;

    const q=Math.sqrt(a2-c2*srlat2);
    const q1=altitudeKm*q;
    const q2=((q1+a2)/(q1+b2))**2;
    const ct=srlat/Math.sqrt(q2*crlat2+srlat2);
    const st=Math.sqrt(Math.max(0,1-ct*ct));
    const r2=altitudeKm*altitudeKm+2*q1+(a4-c4*srlat2)/(q*q);
    const r=Math.sqrt(r2);
    const d=Math.sqrt(a2*crlat2+b2*srlat2);
    const ca=(altitudeKm+d)/r;
    const sa=c2*crlat*srlat/(r*d);

    const sp=Array(SIZE).fill(0),cp=Array(SIZE).fill(0),pp=Array(SIZE).fill(0);
    sp[0]=0;cp[0]=1;pp[0]=1;sp[1]=srlon;cp[1]=crlon;
    for(let m=2;m<=MAX_DEGREE;m++){
      sp[m]=sp[1]*cp[m-1]+cp[1]*sp[m-1];
      cp[m]=cp[1]*cp[m-1]-sp[1]*sp[m-1];
    }

    const p=matrix(),dp=matrix(),tc=matrix();
    p[0][0]=1;dp[0][0]=0;
    const dt=time-state.epoch;
    let br=0,bt=0,bp=0,bpp=0;
    const aor=re/r;
    let ar=aor*aor;

    for(let n=1;n<=MAX_DEGREE;n++){
      ar*=aor;
      for(let m=0;m<=n;m++){
        if(n===m){
          p[m][n]=st*p[m-1][n-1];
          dp[m][n]=st*dp[m-1][n-1]+ct*p[m-1][n-1];
        }else if(n===1&&m===0){
          p[m][n]=ct*p[m][n-1];
          dp[m][n]=ct*dp[m][n-1]-st*p[m][n-1];
        }else{
          if(m>n-2){p[m][n-2]=0;dp[m][n-2]=0;}
          p[m][n]=ct*p[m][n-1]-state.k[m][n]*p[m][n-2];
          dp[m][n]=ct*dp[m][n-1]-st*p[m][n-1]-state.k[m][n]*dp[m][n-2];
        }

        tc[m][n]=state.c[m][n]+dt*state.cd[m][n];
        if(m!==0)tc[n][m-1]=state.c[n][m-1]+dt*state.cd[n][m-1];

        const par=ar*p[m][n];
        let temp1,temp2;
        if(m===0){
          temp1=tc[m][n]*cp[m];
          temp2=tc[m][n]*sp[m];
        }else{
          temp1=tc[m][n]*cp[m]+tc[n][m-1]*sp[m];
          temp2=tc[m][n]*sp[m]-tc[n][m-1]*cp[m];
        }
        bt-=ar*temp1*dp[m][n];
        bp+=state.fm[m]*temp2*par;
        br+=state.fn[n]*temp1*par;

        if(st===0&&m===1){
          if(n===1)pp[n]=pp[n-1];
          else pp[n]=ct*pp[n-1]-state.k[m][n]*pp[n-2];
          bpp+=state.fm[m]*temp2*ar*pp[n];
        }
      }
    }

    bp=st===0?bpp:bp/st;
    const x=-bt*ca-br*sa;
    const y=bp;
    const z=bt*sa-br*ca;
    const horizontal=Math.hypot(x,y);
    const total=Math.hypot(horizontal,z);
    const declination=Math.atan2(y,x)/DEG_TO_RAD;
    const inclination=Math.atan2(z,horizontal)/DEG_TO_RAD;

    return {
      model:state.model,
      epoch:state.epoch,
      decimalYear:time,
      declination,
      inclination,
      x,y,z,horizontal,total
    };
  }

  const api={
    load,
    calculate,
    decimalYear,
    get loaded(){return state.loaded;},
    get error(){return state.error;},
    get epoch(){return state.epoch;},
    get model(){return state.model;}
  };
  api.ready=load();
  global.WMM2025=api;
})(window);

(()=>{
  if(document.querySelector('script[data-solarwatch-share]'))return;
  const s=document.createElement('script');
  s.src='share-data.js';
  s.dataset.solarwatchShare='1';
  document.head.appendChild(s);
})();
