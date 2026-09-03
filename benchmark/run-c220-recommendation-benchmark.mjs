import { readFile } from 'node:fs/promises';
import { inferRackServerProfile, recommendRackComponents } from '../packages/shared/dist/index.js';

const fixture = JSON.parse(await readFile(new URL('./c220-live-catalog.json', import.meta.url), 'utf8'));
const cases = JSON.parse(await readFile(new URL('./c220-recommendation-cases.json', import.meta.url), 'utf8'));
const profile = fixture.platformProfile ?? inferRackServerProfile('UCSC-C220-M8S');
const requirement = (item) => ({id:item.id,label:item.id,value:item.value,...(item.unit===undefined?{}:{unit:item.unit}),status:'explicit',required:true,evidence:[]});
const riserVariant = (option) => (`${option.sku} ${option.attributes?.categoryName??''}`.match(/\bRIS(\d)([AB])\b/i)?.[2] ?? `${option.sku} ${option.attributes?.categoryName??''}`.match(/\bRiser\s+\d([AB])\b/i)?.[1])?.toUpperCase();

const results = cases.map((testCase) => {
  let catalog=fixture.options.map((option)=>({...option,attributes:{...option.attributes}}));
  if(testCase.excludeSkus?.length) catalog=catalog.filter((option)=>!testCase.excludeSkus.includes(option.sku));
  for(const selected of testCase.selectedOptions??[]){
    const option=catalog.find((item)=>item.sku===selected.sku&&(!selected.categoryNameIncludes||String(item.attributes.categoryName).includes(selected.categoryNameIncludes)));
    if(option) Object.assign(option.attributes,{selected:true,selectedQuantity:selected.quantity});
  }
  const recommendation=recommendRackComponents(testCase.requirements.map(requirement),catalog,profile);
  const status=recommendation.violations.length?'unsatisfied':recommendation.notices.length?'partial':recommendation.components.length?'complete':'empty';
  const selected=recommendation.components.flatMap((component)=>component.selections.map((selection)=>({component:component.component,quantity:selection.quantity,option:catalog.find((option)=>option.id===selection.optionId)})));
  const failures=[];
  if(status!==testCase.expectStatus) failures.push(`expected status ${testCase.expectStatus}, received ${status}`);
  for(const expected of testCase.expectedSelections??[]){
    if(!selected.some((item)=>item.option?.sku===expected.sku&&item.quantity===expected.quantity&&(!expected.component||item.component===expected.component)&&(!expected.categoryNameIncludes||String(item.option?.attributes.categoryName).includes(expected.categoryNameIncludes)))) failures.push(`missing ${expected.quantity}x ${expected.sku}${expected.categoryNameIncludes?` at ${expected.categoryNameIncludes}`:''}`);
  }
  for(const component of testCase.expectedComponents??[]) if(!selected.some((item)=>item.component===component)) failures.push(`missing component ${component}`);
  for(const component of testCase.forbiddenComponents??[]) if(selected.some((item)=>item.component===component)) failures.push(`forbidden component ${component}`);
  for(const fragment of testCase.violationIncludes??[]) if(!recommendation.violations.some((message)=>message.includes(fragment))) failures.push(`missing violation containing: ${fragment}`);
  if(testCase.expectStatus==='complete'&&recommendation.violations.length) failures.push(`unexpected violations: ${recommendation.violations.join(' | ')}`);
  if(testCase.expectFrontStorageOnly&&selected.some((item)=>item.component==='storage'&&item.option?.attributes.storageLocation!=='front')) failures.push('capacity drive is not front-facing');
  if(testCase.expectRaid1Two){const lines=recommendation.components.filter((c)=>c.component==='storage').flatMap((c)=>c.reason.split('\n')).filter((line)=>/RAID 1\b/i.test(line));if(!lines.length||lines.some((line)=>!/\b2\s*[×x]/.test(line))) failures.push('RAID 1 is not exactly two drives');}
  if(testCase.expectSingleRiserVariant){const all=[...selected.map((x)=>x.option),...catalog.filter((o)=>o.attributes.selected===true)].filter(Boolean);const variants=new Set(all.map(riserVariant).filter(Boolean));if(variants.size>1) failures.push(`mixed riser variants: ${[...variants].join(', ')}`);}
  const capacityDriveCount=selected.filter((item)=>item.component==='storage').reduce((sum,item)=>sum+item.quantity,0);
  if(capacityDriveCount>10) failures.push(`${capacityDriveCount} capacity drives exceed ten front bays`);
  return {id:testCase.id,status,passed:failures.length===0,failures,selections:selected.map((item)=>`${item.component}: ${item.quantity}x ${item.option?.sku??'unknown'} @ ${item.option?.attributes.categoryName??''}`),violations:recommendation.violations};
});
const report={benchmark:'C220 M8 recommendation compatibility',specSheet:'ucs-specsheet/ucs-c220-m8-sff-rack-server.pdf',catalogSource:fixture.source,platform:profile.model,catalogOptions:fixture.options.length,cases:results.length,passed:results.filter((r)=>r.passed).length,failed:results.filter((r)=>!r.passed).length,results};
console.log(JSON.stringify(report,null,2));
if(report.failed) process.exitCode=1;
