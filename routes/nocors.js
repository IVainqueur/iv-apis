const express = require('express')
const app = express.Router()
const {_pick, _remove, arr_remove} = require('../oneliners')
const fetch = require('node-fetch')




app.post("/", async (req, res)=>{
    let body = _pick(["headers", "method", "url"], req.body)
    let options = {
        method: body.method ? body.method : 'GET',
        headers: body.headers
    }
    let response = await fetch(body.url, options)
    let data = await response.text()
    try{
        let toSend = JSON.parse(data)
        res.send({data: toSend, isJson: true})

    }catch(e){
        res.send({
            data, isJson: false
        })
    }

})

module.exports = app