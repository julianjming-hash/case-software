// Inactivity pauses reads only. It never locks the interface or changes authentication.
export function createAdminPolling({refresh,now=Date.now,schedule=setTimeout,cancel=clearTimeout,onPause=()=>{},intervalMs=30000,idleMs=600000}={}){
 let lastActivity=now(),timer=null,closed=false,flight=false,isPaused=false;
 function pause(value){if(isPaused===value)return;isPaused=value;onPause(value);}
 function queue(){if(!closed&&!isPaused){if(timer!==null)cancel(timer);timer=schedule(tick,intervalMs);}}
 async function tick(){
  if(closed||flight)return;
  timer=null;if(now()-lastActivity>=idleMs){pause(true);return;}
  flight=true;try{await refresh();}catch{}finally{flight=false;queue();}
 }
 return {
  start(){if(closed)return;lastActivity=now();queue();},
  paused:()=>isPaused,
  async activity(){if(closed)return;lastActivity=now();if(isPaused){pause(false);await tick();}},
  close(){closed=true;if(timer!==null)cancel(timer);timer=null;},
 };
}
