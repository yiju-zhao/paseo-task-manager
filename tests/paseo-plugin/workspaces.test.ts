import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test, expect, vi } from 'vitest';
import { checkoutReader, optionalFileCounter, openSource, repositoryReads } from '../../server/route.ts';
import { DIFF_BACKOFF_MS, RemoteWorkspaces } from '../../server/workspaces.ts';

test('checkout transport only requests uncommitted differences and exposes a count; errors and incomplete inventories are unknown', async () => {
  const diff = vi.fn().mockResolvedValueOnce({files:[{hunks:['private']},{path:'private'}]})
    .mockResolvedValueOnce({files:[],diffTooLarge:true}).mockResolvedValueOnce({error:{message:'failed'},files:[]}).mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValueOnce({files:'unexpected SDK response'});
  const transport = new Proxy({getCheckoutDiff:diff}, {get(t,k) {
    if (k !== 'getCheckoutDiff') throw new Error('unexpected checkout method');
    return t.getCheckoutDiff;
  }});
  const count = checkoutReader(transport);
  expect(await count('/remote')).toBe(2);
  for (let i=0;i<4;i++) expect(await count('/remote')).toBeNull();
  expect(diff.mock.calls).toEqual(Array(5).fill(['/remote',{mode:'uncommitted'}]));
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive:true, force:true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-workspace-'));
  dirs.push(dir);
  let time = Date.parse('2026-11-24T12:00:00Z');
  const now = () => new Date(time);
  const advance = (ms: number) => { time += ms; };
  const git = {currentBranch:'work',aheadOfOrigin:7,behindOfOrigin:2,aheadBehind:{ahead:55,behind:44},isDirty:true};
  const stat = { additions:110, deletions:22 };
  const w = { projectKind:'git', workspaceKind:'worktree', projectRootPath:'/main', workspaceDirectory:'/worktree', gitRuntime:git, diffStat:stat };
  const refresh = vi.fn(async () => w);
  const workspaces = new Proxy({ref:() => ({refresh})}, {get(t,k){ if(k!=='ref')throw new Error('unexpected workspace method');return t.ref; }});
  const count = vi.fn<(cwd:string)=>Promise<number|null>>().mockResolvedValue(19);
  const repository = repositoryReads(workspaces as unknown as Parameters<typeof repositoryReads>[0],count);
  const open = () => new RemoteWorkspaces(repository,dir);
  return { dir,now,advance,git,stat,count,open,reader:open() };
}

test('unchanged descriptors keep the count and its date across polls, aliases and reload, while branch metadata stays live', async () => {
  const f=fixture();
  const first=await f.reader.read('A',f.now);
  expect(first).toEqual({root:'/worktree',branch:'work',ahead:7,behind:2,dirty:19,recent:[],checked_at:f.now().toISOString()});
  f.advance(24*3600_000);
  f.git.currentBranch='another';
  f.git.aheadOfOrigin=8;
  const reader=f.open();
  expect(await reader.read('alias',f.now)).toEqual({...first,branch:'another',ahead:8});
  expect(await reader.read('A',f.now)).toEqual({...first,branch:'another',ahead:8});
  expect(f.count).toHaveBeenCalledTimes(1);
});

test('each changed additions/deletions signature requests once even with concurrent aliases; clean is exactly zero', async () => {
  const f=fixture();
  const read=()=>f.reader.read('a',f.now);
  await read();
  f.stat.additions++;
  await Promise.all([read(),f.reader.read('alias',f.now)]);
  f.stat.deletions++;
  await read(); await read();
  expect(f.count).toHaveBeenCalledTimes(3);
  f.git.isDirty=false;
  expect((await read())?.dirty).toBe(0);
  expect(f.count).toHaveBeenCalledTimes(3);
  f.git.isDirty=true; await read();
  expect(f.count).toHaveBeenCalledTimes(4);
});

test('failure starts 30 minutes of persisted per-directory backoff after the attempt finishes, even when the stats change', async () => {
  const f=fixture();
  const first=await f.reader.read('A',f.now);
  f.stat.additions++;
  f.count.mockImplementationOnce(async () => { f.advance(60_000); throw new Error('timeout'); });
  expect(await f.reader.read('A',f.now)).toEqual(first);
  const reader=f.open();
  f.stat.deletions++; f.git.aheadOfOrigin=11;
  f.advance(DIFF_BACKOFF_MS-1);
  expect(await reader.read('alias',f.now)).toEqual(first);
  expect(reader.unknownCounts.get('alias')).toMatchObject({isDirty:true,ahead:11});
  expect(f.count).toHaveBeenCalledTimes(2);
  f.advance(1); f.count.mockResolvedValueOnce(28);
  expect(await reader.read('alias',f.now)).toMatchObject({dirty:28,ahead:11,checked_at:f.now().toISOString()});
  await reader.read('A',f.now);
  expect(f.count).toHaveBeenCalledTimes(3);
  expect(readFileSync(join(f.dir,'workspace-snapshots.json'),'utf8')).not.toContain('hunks');
});

test('old per-workspace snapshots remain available when no new count can be obtained', async () => {
  const f=fixture();
  const old={root:'/worktree',branch:'old',ahead:null,behind:null,dirty:4,recent:[],checked_at:f.now().toISOString()};
  writeFileSync(join(f.dir,'workspace-snapshots.json'),JSON.stringify({A:old}));
  f.advance(3600_000); f.count.mockResolvedValue(null);
  const reader=f.open();
  expect(await reader.read('A',f.now)).toEqual(old);
  expect(await reader.read('B',f.now)).toEqual(old);
  expect(f.count).toHaveBeenCalledTimes(1);
});

test('failure to load the optional internal modules leaves the public host, agent timeline and workspace reads usable', async () => {
  const load=vi.fn(async()=>{throw Error('internal export unavailable');});
  const count=optionalFileCounter('ws://unused','self','remote',load);
  const refresh=vi.fn(async()=>({agent:{id:'a',status:'idle',availableModes:['default']}}));
  const refetch=vi.fn(async()=>({entries:[],agent:null}));
  const workspace={gitRuntime:{isDirty:true,currentBranch:'work'}};
  const scope={agents:{list:async()=>({entries:[],pageInfo:{hasMore:false,nextCursor:null}}),ref:()=>({refresh,timeline:{refetch}})},
    workspaces:{ref:()=>({refresh:async()=>workspace})},dispose:vi.fn(async()=>{})};
  const origin={hosts:{client:vi.fn(async()=>scope)},getConnectionState:()=>({status:'connected'})};
  const {sdk,repository}=await openSource(origin as unknown as Parameters<typeof openSource>[0],'remote',()=>true,()=>false,count);
  expect(load).not.toHaveBeenCalled();
  expect(await repository.changedFileCount('/repo')).toBeNull();
  expect(await repository.workspace('w')).toBe(workspace);
  expect((await sdk.listAgents({limit:4,includeArchived:true,includeBackground:true})).entries).toEqual([]);
  await sdk.fetchTimeline('a',{direction:'tail',limit:1});
  await sdk.close();
  expect(origin.hosts.client).toHaveBeenCalledWith('remote');
  expect(refetch).toHaveBeenCalledOnce(); expect(scope.dispose).toHaveBeenCalledOnce();
});
