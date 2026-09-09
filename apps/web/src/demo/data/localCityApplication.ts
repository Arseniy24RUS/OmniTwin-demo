/** Development transport selection, never a recovery from a failed public fetch. */
export function isLocalCityApplication(development:boolean,applicationBaseUrl:string,href:string):boolean {
  if(!development)return false;
  try{
    const application=new URL(href),root=new URL(applicationBaseUrl,application);
    return ['http:','https:'].includes(application.protocol)
      &&['127.0.0.1','localhost','[::1]'].includes(application.hostname)
      &&root.origin===application.origin&&!root.username&&!root.password
      &&!application.username&&!application.password;
  }catch{return false;}
}
