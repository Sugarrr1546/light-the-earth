import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {presentRegion,canLabelRegion} from '../lib/region-presentation.ts';

const data = file => JSON.parse(readFileSync(new URL('../public/data/' + file, import.meta.url)));
const names = data('name-quality.json');
const repairs = data('china-name-repairs.json').repairs;
const features = data('aligned/chn.geojson').features;
const byId = new Map(features.map(f => [f.id, f]));
const show = id => presentRegion(byId.get(id).properties, names);

test('Penglai and Changdao retain separate retired identities, not a renamed 2017 district', () => {
  for (const [id,name] of [['GB-62558664B12405344807684','蓬莱市'],['GB-62558664B6773775584691','长岛县']]) {
    assert.match(show(id).name,new RegExp('^' + name));
    assert.match(show(id).name,/已撤销/);
    assert.equal(repairs[id].boundaryStatus,'historical');
    assert.equal(repairs[id].currentIdentityVerified,false);
    assert.equal(repairs[id].retirementKind,'administrative-unit-abolished');
  }
});

test('Hotan County never uses the city code or city name', () => {
  const r=repairs['GB-62558664B74742365546697'];
  assert.equal(r.name,'和田县');
  assert.equal(r.parentName,'和田地区');
  assert.equal(r.evidence.code.replaceAll(' ',''),'653221');
  assert.equal(r.currentIdentityVerified,false);
});

test('dissolved units and ambiguous duplicate labels cannot be asserted current', () => {
  for(const id of ['GB-62558664B46796129001475','GB-62558664B6154155573410']) {
    assert.equal(repairs[id].retirementKind,'administrative-unit-abolished');
    assert.match(show(id).name,/已撤销/);
  }
  assert.equal(show('GB-62558664B79559667680658').parentName,'拉萨市');
  assert.equal(show('GB-62558664B85889461922047').parentName,'天津市');
  assert.match(show('GB-62558664B85889461922047').name,/蓟县/);
  assert.equal(canLabelRegion(show('GB-62558664B28924499867484')),false);
  assert.equal(show('GB-62558664B28924499867484').nameStatus,'unresolved');
});

test('source-year fallback is explicit and neither geometry nor stable IDs are rewritten', () => {
  for(const id of ['GB-62558664B9496053300630','GB-62558664B74742365546697']) {
    const p=byId.get(id).properties,r=show(id);
    assert.notEqual(r.boundaryStatus,'current');
    assert.match(r.nameNote,/2017/);
    assert.match(r.nameNote,/未.*核验.*现行|现行.*未.*核验/);
    assert.equal(r.id,p.id); assert.equal(r.year,p.year);
    assert.deepEqual(r.bbox,p.bbox);
  }
});

test('name matcher rejects abolished items and county/city/district substitutions', () => {
  // Execute the actual pure matcher without requiring geodata/translation packages.
  const script=`import ast,pathlib,re,unicodedata\ntree=ast.parse(pathlib.Path('scripts/prepare-china-names.py').read_text())\nnodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'norm_en','administrative_kind','compatible_identity'} or isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='STOP' for t in n.targets)]\nns={'re':re,'unicodedata':unicodedata}\nexec(compile(ast.Module(body=nodes,type_ignores=[]),'actual-name-matcher','exec'),ns)\ncompatible=ns['compatible_identity']\nassert not compatible('Hotan County',{'en':'Hotan','dissolved':False})\nassert not compatible('Penglai City',{'en':'Penglai District','dissolved':False})\nassert not compatible('Nanjiao District',{'en':'Nanjiao District','dissolved':True})\nassert compatible('Hotan County',{'en':'Hotan County','dissolved':False})\n`;
  const result=spawnSync(process.env.PYTHON || 'python3',['-c',script],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
