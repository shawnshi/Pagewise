import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compile, emit, runJvm, root, jsonAdapter, groovy } from './native-import-test-tools.mjs'
const directory=process.env.PW_ADMISSION_SOURCE_DIR || join(root,'src-tauri/android')
const panel=readFileSync(join(directory,'NativeLibraryPanel.kt'),'utf8')
const controller=readFileSync(join(directory,'NativePagesController.kt'),'utf8')
function member(text,name,optional=false){
  const start=text.indexOf('    private fun '+name+'(')
  if(start<0){if(optional)return '';throw Error('missing production member '+name)}
  const end=text.slice(start+1).search(/\n    (?:private )?fun /)
  return text.slice(start,end<0?undefined:start+1+end)
}

test('execute production async callbacks against held transport and UI ports',()=>{
  const out=resolve(root,'../.cache/native-library-admission-async',`${Date.now()}-${process.pid}`);mkdirSync(out,{recursive:true})
  const policy=panel.match(/internal fun nativeLibraryCanAct\([\s\S]*?\n\) = [^\n]+/u)[0]
  const models=panel.slice(panel.indexOf('internal class NativeLibrarySearch'),panel.indexOf('internal class NativeLibraryPanel'))
  const dialogGuard=member(controller,'disableLibraryDialogOperations',true)
  const main=emit(out,'Async.kt',`import org.json.*
${policy}
${models}
object View{const val VISIBLE=0;const val GONE=8;const val ACCESSIBILITY_LIVE_REGION_ASSERTIVE=2}
class Widget(var text:String="",var visibility:Int=0,var isEnabled:Boolean=true,var accessibilityLiveRegion:Int=0)
class AlertDialog{companion object{const val BUTTON_POSITIVE=-1;const val BUTTON_NEUTRAL=-3};val buttons=mutableMapOf<Int,Widget>();val listView:Widget?=Widget();fun getButton(n:Int)=buttons.getOrPut(n){Widget()}}
class MainQueue{fun post(action:()->Unit){action()}}
typealias NativePageReply=(JSONObject?,String?)->Unit
internal class Frame{
 var epoch=0L;var closed=false;var failed=false;var loading=false;var mutating=false;var navigating=false;var fatalDatabase=false
 val keywordSearch=NativeLibrarySearch();val state=NativeLibraryUiState();val status=Widget();val notice=Widget();val retry=Widget();var keywordInput:Widget?=Widget("keep typed input")
 val dialogs=mutableListOf<AlertDialog>();val session=JSONObject();val current=JSONObject().put("selectionToken","frozen");val main=MainQueue()
 var oldDisabled=false;var navigations=0;var resumes=0;var paints=0;var accepted=0;var presented=0;var onFailure:()->Unit={};var onSummary:(String?)->Unit={}
 val waiting=mutableListOf<NativePageReply>()
 private fun canAct()=nativeLibraryCanAct(closed,failed,loading,mutating,navigating,fatalDatabase)
 fun canLeave()=!mutating&&(failed||keywordSearch.canLeave)
 fun canOperate()=canAct()
 fun canMutate()=canAct()&&!state.outcomeUnknown
 private fun tr(zh:String,en:String)=en
 private fun disableOldResult(){oldDisabled=true}
 private fun resumeSearchWhenIdle(){resumes++}
 private fun repaint(){paints++}
 private fun ask(action:String,payload:JSONObject,reply:NativePageReply){accepted++;waiting.add(reply)}
 fun settle(value:JSONObject?=JSONObject(),error:String?=null){waiting.removeAt(0)(value,error)}
 fun open(){remember("fixture"){navigations++}}
 fun fail(code:String){showFailure(code)}
 fun collect(last:JSONObject){collectReadingPages(last,epoch){presented++}}
${member(panel,'unsafeDatabase')}
${member(panel,'showFailure')}
${member(panel,'remember')}
${member(panel,'collectReadingPages')}
}
internal class Controller(val frame:Frame){
 var libraryPanel:Frame?=frame;var currentDialog:AlertDialog?=AlertDialog();var generation=0L;var page="library";var refreshes=0;var error="";var confirmation:(()->Unit)?=null
 val calls=mutableListOf<String>();val acknowledgements=mutableListOf<(JSONObject)->Unit>()
 private fun call(action:String,payload:JSONObject,done:(JSONObject)->Unit){calls.add(action);acknowledgements.add(done)}
 private fun refresh(){refreshes++}
 private fun navigate(path:String){}
 private fun showError(code:String){error=code}
 private fun confirm(title:String,message:String,done:()->Unit){confirmation=done}
 fun disableForFailure(){${dialogGuard?'disableLibraryDialogOperations()':''}}
 fun patch(){patchBook(JSONObject().put("id","fixture"),JSONObject().put("readingStatus","read"))}
 fun remove(){removeBook(JSONObject().put("id","fixture").put("title","fixture"))}
${dialogGuard}
${member(controller,'patchBook')}
${member(controller,'removeBook')}
}
fun lastPage(total:Int=4)=JSONObject().put("page",2).put("pageSize",2).put("total",total).put("session",JSONObject()).put("selectionToken","frozen").put("items",JSONArray(listOf(JSONObject().put("id","c"),JSONObject().put("id","d"))))
fun main(){
 var failures=0
 fun scenario(name:String,checkCase:()->Unit){try{checkCase();println("PASS "+name)}catch(error:Throwable){failures++;println("FAIL "+name+": "+error.message)}}
 scenario("late accepted open receipt after fatal does not navigate or replay"){
  val f=Frame();f.open();check(f.accepted==1&&f.navigating);f.fail("library_database_corrupt");f.settle();check(f.navigations==0&&!f.navigating&&f.accepted==1)
 }
 scenario("current successful open still navigates once"){
  val f=Frame();f.open();f.settle();check(f.navigations==1&&f.accepted==1&&!f.navigating)
 }
 scenario("busy and closed frames refuse delayed open receipts"){
  for(kind in 0..1){val f=Frame();f.open();if(kind==0)f.loading=true else f.closed=true;f.settle();check(f.navigations==0)}
 }
 scenario("controller menu is disabled and late pin/remove cannot submit"){
  val f=Frame();val c=Controller(f);f.onFailure={c.disableForFailure()};c.remove();f.fail("library_database_corrupt");c.confirmation!!();c.patch();check(c.calls.isEmpty());check(c.currentDialog!!.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled==false);check(c.currentDialog!!.listView!!.isEnabled==false);check(f.keywordInput!!.text=="keep typed input")
 }
 scenario("unknown batch forbids controller writes"){
  val f=Frame();val c=Controller(f);f.state.outcomeUnknown=true;c.patch();c.remove();check(c.calls.isEmpty()&&c.confirmation==null)
 }
 scenario("changed controller generation rejects old removal confirmation"){
  val c=Controller(Frame());c.remove();c.generation++;c.confirmation!!();check(c.calls.isEmpty())
 }
 scenario("already accepted book write settles without cancellation or replay"){
  val f=Frame();val c=Controller(f);c.patch();check(c.calls==listOf("library.bookPatch"));f.fail("library_database_corrupt");c.acknowledgements.removeAt(0)(JSONObject());check(c.calls==listOf("library.bookPatch")&&c.refreshes==1)
 }
 scenario("intermediate reading page failure provides explicit retry and Back"){
  val f=Frame();f.collect(lastPage());f.settle(null,"synthetic_read_failure");check(f.failed&&!f.loading&&f.oldDisabled&&f.retry.visibility==View.VISIBLE&&f.canLeave()&&f.presented==0)
 }
 scenario("reading catalog identity/count change provides explicit retry"){
  val f=Frame();f.collect(lastPage());f.settle(JSONObject().put("ok",true).put("total",5));check(f.failed&&f.status.text.contains("reading_catalog_changed_refresh_required")&&f.retry.visibility==View.VISIBLE&&f.presented==0)
 }
 scenario("failure clears the current header summary without replacing input") {
  val f=Frame();var summary:String?="old";f.onSummary={summary=it};f.fail("network_error");check(summary==null&&f.keywordInput!!.text=="keep typed input")
 }
 check(failures==0){"async regression failures="+failures};println("ASYNC_10_PASS")
}
`)
  const json=emit(out,'Json.kt',jsonAdapter()+'\nclass JSONException(message:String):RuntimeException(message)\n')
  const cp=compile(out,[json,main],groovy());const output=runJvm(out,'run',['-cp',cp,'AsyncKt']);assert.match(output,/ASYNC_10_PASS/)
})

test('controller menus and failure notification are connected to live panel admission',()=>{
  assert.ok(controller.includes('::disableLibraryDialogOperations'),'wire controller dialog invalidation')
  assert.doesNotMatch(controller,/if \(libraryPanel\?\.canLeave\(\) != false\) bookMenu/)
  assert.match(controller,/ownerGeneration == generation && libraryPanel\?\.canOperate\(\) != false/)
  assert.match(member(panel,'showFailure'),/onFailure\(\)/)
})
