import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/vendor/foliate/paginator.js', import.meta.url), 'utf8')
const turn = source.slice(source.indexOf('    async #turnPage('), source.indexOf('    async prev(', source.indexOf('    async #turnPage(')))
function harness() {
  const timers = []
  const Paginator = vm.runInNewContext(`(class {
    #locked=false; #navigationEpoch=0; calls=[]; scroll=async()=>false; go=async()=>{};
    hasAttribute(){return false}
    #scrollPrev(distance){this.calls.push(['prev',distance]);return this.scroll()}
    #scrollNext(distance){this.calls.push(['next',distance]);return this.scroll()}
    #adjacentIndex(dir){return dir}
    #goTo(target){this.calls.push(['go',target.index]);return this.go(target)}
    ${turn}
    turn(dir,distance){return this.#turnPage(dir,distance)}
    replace(){this.#navigationEpoch++;this.#locked=false}
  })`, { wait: async ms => { timers.push(ms) } })
  return { paginator: new Paginator(), timers }
}
function deferred() { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject} }

test('nonanimated committed turns have no timer tail; direction/distance and chapter readiness survive', async () => {
  const {paginator:p,timers} = harness()
  for (let i=0;i<100;i++) await p.turn(i%2 ? -1 : 1,37)
  assert.equal(p.calls.length,100)
  assert.equal(p.calls[0][0],'next'); assert.equal(p.calls[1][0],'prev'); assert.equal(p.calls[1][1],37)
  p.scroll=async()=>true
  const chapter=deferred();p.go=()=>chapter.promise
  let finished=false;const pending=p.turn(1).then(()=>{finished=true})
  await Promise.resolve(); await Promise.resolve(); assert.equal(finished,false,'resolved before chapter readiness')
  chapter.resolve();await pending
  assert.equal(p.calls.at(-1)[0],'go')
  assert.deepEqual(timers,[],'synthetic lock tail remains after committed readiness')
})
test('scroll and chapter exceptions release the lock without hiding the error', async () => {
  for (const stage of ['scroll','go']) {
    const {paginator:p}=harness();const error=Error(stage)
    p.scroll=async()=>stage==='go'; p[stage]=async()=>{throw error}
    await assert.rejects(p.turn(1),e=>e===error)
    p.scroll=async()=>false;p.go=async()=>{};const before=p.calls.length;await p.turn(-1)
    assert.equal(p.calls.length,before+1,'error left navigation locked')
  }
})
test('replacement/close during scroll cannot navigate a new session or unlock its active turn', async () => {
  const {paginator:p}=harness();const old=deferred();p.scroll=()=>old.promise
  const stale=p.turn(1);p.replace()
  const current=deferred();p.scroll=()=>current.promise;const active=p.turn(-1)
  old.resolve(true);await stale
  const before=p.calls.length;const busy=p.turn(1)
  current.resolve(false);await Promise.all([active,busy])
  assert.equal(p.calls.length,before,'stale finally unlocked newer turn')
  assert.equal(p.calls.some(c=>c[0]==='go'),false,'stale turn loaded a chapter after close/replacement')
  await p.turn(1);assert.equal(p.calls.length,before+1)
})
