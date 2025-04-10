const app = require('express').Router()

app.get('/:id/:amount', async (req, res) => {
    const { id, amount } = req.params
    
    if(!id || !amount) return res.status(400).send("Missing required parameters")

    const isMerchant = Boolean(id.length < 10)

    res.redirect(`tel:*182*${isMerchant ? '8' : '1'}*1*${id}*${amount}#`)
    
})

module.exports = app