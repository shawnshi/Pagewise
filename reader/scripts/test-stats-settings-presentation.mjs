import assert from 'node:assert/strict'
import {test} from 'node:test'
import {nativeSettingOptionLabel,createNativeSettingsActions} from '../src/services/nativeSettingsEditing.ts'
import {readFileSync} from 'node:fs'

test('display labels keep canonical booleans, enums and path-specific meaning separate',()=>{
 assert.equal(nativeSettingOptionLabel(true,'en'),'On');assert.equal(nativeSettingOptionLabel(false,'zh'),'关闭')
 assert.equal(nativeSettingOptionLabel('system','zh'),'跟随系统');assert.equal(nativeSettingOptionLabel('system','en',['ttsEngine']),'System speech')
 assert.equal(nativeSettingOptionLabel(2,'zh',['reader','maxColumnCount']),'双栏');assert.equal(nativeSettingOptionLabel('unrecognized','en'),'unrecognized')
 assert.equal(nativeSettingOptionLabel(null,'en'),'null')
})
test('schema options have bounded bilingual display arrays without reading settings or secrets',async()=>{
 const owner=new Proxy({},{get(_,key){throw Error('Schema accessed owner '+String(key))}})
 const schema=await createNativeSettingsActions({},owner).settingsSchema({});assert.equal(schema.ok,true)
 for(const field of schema.fields){const options=field.kind==='boolean'?[false,true]:field.options;if(!options)continue;assert.equal(field.optionLabels.length,options.length);assert.equal(field.optionLabelsEn.length,options.length);for(const label of [...field.optionLabels,...field.optionLabelsEn])assert.equal(typeof label,'string')}
})
test('native content reattaches directly to its ScrollView, never to itself',()=>{
 const source=readFileSync(new URL('../src-tauri/android/NativePagesController.kt',import.meta.url),'utf8')
 assert.match(source,/if \(body\.parent !== scroll\)[\s\S]*?scroll\.addView\(body,/)
 assert.doesNotMatch(source,/val holder = scroll\.getChildAt\(0\)/)
})
