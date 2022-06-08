const express = require('express')
const app = express.Router()
const {_pick, _remove, arr_remove} = require('../oneliners')
const fetch = require('node-fetch')




app.post("/", async (req, res)=>{
    let body = _pick(["headers", "method", "url", "body"], req.body)
    let options = {
        method: body.method ? body.method : 'GET',
        headers: body.headers,
        body: JSON.stringify(body.body)
    }
    console.log(options)
    try{
        let response = await fetch(body.url, options)
    }catch(e){
        res.json({code: "#Error", message: e})
    }
    let headers = {}
    for (let pair of response.headers.entries()) {
        headers[pair[0]] = pair[1]
    }
    let data = await response.text()
    try{
        let toSend = JSON.parse(data)
        res.send({data: toSend, isJson: true, headers})

    }catch(e){
        res.send({
            data, isJson: false
        })
    }

})

module.exports = app