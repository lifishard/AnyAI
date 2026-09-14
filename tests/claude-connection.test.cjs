const test=require('node:test'),assert=require('node:assert/strict');
const {readClaudeConnection,gatewayProfile}=require('../electron/claude-connection.cjs');
test('only connection fields from Claude user settings survive isolation',()=>{
 const r=readClaudeConnection({HOME:'/fixture'},()=>JSON.stringify({model:'fallback',env:{ANTHROPIC_BASE_URL:'http://127.0.0.1:20128',ANTHROPIC_AUTH_TOKEN:'private',ANTHROPIC_DEFAULT_OPUS_MODEL:'auto/claude-opus',NODE_OPTIONS:'run arbitrary code',CLAUDE_CODE_SKIP_DANGEROUS_MODE_PERMISSION_PROMPT:'true'},hooks:{},mcpServers:{}}));
 assert.equal(r.env.ANTHROPIC_AUTH_TOKEN,'private');assert.equal(r.env.ANTHROPIC_MODEL,'fallback');assert.equal(r.env.ANTHROPIC_DEFAULT_OPUS_MODEL,'auto/claude-opus');assert.equal(r.env.NODE_OPTIONS,undefined);assert.equal(r.env.CLAUDE_CODE_SKIP_DANGEROUS_MODE_PERMISSION_PROMPT,undefined);assert.equal(r.apiKeyHelper,undefined);
 assert.equal(gatewayProfile(r),null);
 assert.equal(gatewayProfile(r,{keyProfiles:[{name:'OmniRoute',baseUrl:'http://localhost:20128/v1'}]}).baseUrl,'http://127.0.0.1:20128/v1');
});

test('unimplemented credential backends are surfaced instead of falling back to another account',()=>{
 assert.throws(()=>readClaudeConnection({HOME:'/fixture'},()=>JSON.stringify({env:{CLAUDE_CODE_USE_BEDROCK:'1'}})),/专用认证/);
 assert.throws(()=>readClaudeConnection({HOME:'/fixture'},()=>JSON.stringify({apiKeyHelper:'credential-command'})),/动态凭据助手/);
});

test('custom config directory and inherited API settings are provider-neutral',()=>{
 let usedPath;
 const r=readClaudeConnection({HOME:'/fixture',CLAUDE_CONFIG_DIR:'/custom/claude',ANTHROPIC_BASE_URL:'https://shell.example/anthropic',ANTHROPIC_API_KEY:'shell-key',NODE_OPTIONS:'blocked'},p=>{usedPath=p;return JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://company.example/anthropic',ANTHROPIC_CUSTOM_HEADERS:'X-Workspace: team',ANTHROPIC_DEFAULT_SONNET_MODEL:'provider/model-v1'}});});
 assert.equal(usedPath,require('node:path').join('/custom/claude','settings.json'));assert.equal(r.baseUrl,'https://company.example/anthropic');assert.equal(r.env.CLAUDE_CONFIG_DIR,'/custom/claude');assert.equal(r.env.ANTHROPIC_API_KEY,'shell-key');assert.equal(r.env.ANTHROPIC_CUSTOM_HEADERS,'X-Workspace: team');assert.equal(r.env.NODE_OPTIONS,undefined);
 assert.equal(gatewayProfile(r,{keyProfiles:[{name:'OmniRoute',baseUrl:'http://localhost:20128/v1'}]}),null);
});

test('a local address or port never selects a recovery product without a matching profile',()=>{
 const connection={baseUrl:'http://localhost:20128',env:{}};
 assert.equal(gatewayProfile(connection),null);
 assert.equal(gatewayProfile(connection,{keyProfiles:[{name:'OtherGateway',baseUrl:'http://localhost:20128/v1'}]}),null);
 assert.equal(gatewayProfile(connection,{keyProfiles:[{name:'OmniRoute',baseUrl:'http://localhost:30128/v1'}]}),null);
 const otherPort={...connection,baseUrl:'http://127.0.0.1:30128'};
 assert.equal(gatewayProfile(otherPort,{keyProfiles:[{name:'OmniRoute',baseUrl:'http://localhost:30128/v1'}]}).baseUrl,'http://127.0.0.1:30128/v1');
});
test('missing settings preserve native login while corrupt settings are surfaced',()=>{
 assert.deepEqual(readClaudeConnection({HOME:'/fixture'},()=>{throw Object.assign(Error(),{code:'ENOENT'});}),{env:{},baseUrl:null});
 assert.throws(()=>readClaudeConnection({HOME:'/fixture'},()=>'{broken'),/配置无法读取/);
 assert.equal(gatewayProfile({baseUrl:'https://remote.example',env:{}}),null);
});
