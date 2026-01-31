const child_process = require('child_process')
const { exit } = require('process')
const mc = child_process.exec('java -jar mc.jar')
mc.stdout.on('data', function (data) {
    if (data.slice(data.indexOf(']: ')+3, data.length-1) == '已重新读取白名单');
    process.stdout.write(data)
})
mc.stderr.on('data', function (data) {
    process.stderr.write(data)
})
mc.on('close', function (code) {
    exit(code)
})
const readline = require('readline')
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})
rl.on('line', function (input) {
    mc.stdin.write(input + '\n')
})
setInterval(() => {
    mc.stdin.write('whitelist reload\n')
}, 1000)