import {createCollaborationStatusParser} from './collaborationSchema';
const parse=createCollaborationStatusParser();
let previousId=0;
let previous=new Map<string,string>();
const scope=self as unknown as {onmessage:(event:MessageEvent<{id:number;value:unknown}>)=>void;postMessage:(value:unknown)=>void};
scope.onmessage=event=>{
 const {id,value}=event.data;
 try{
  const status=parse(value),patch:Record<string,unknown>={},next=new Map<string,string>();let size=0;
  for(const [key,field] of Object.entries(status)){
   const encoded=JSON.stringify(field);
   if(previous.get(key)!==encoded)patch[key]=field;
   next.set(key,encoded);size+=encoded.length;
  }
  scope.postMessage({id,ok:true,base:previousId,patch});previousId=id;previous=size<=8*1024*1024?next:new Map();
 }
 catch{scope.postMessage({id,ok:false});}
};
