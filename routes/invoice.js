const app = require('express').Router()

const isMobileBrowser = (userAgent) => {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
}

const getMobileBrowserRequiredHtml = (req) => {
    return `
        <html>
            <head>
                <title>MTN Mobile Money Invoice - Easy Payment Solution</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                
                <!-- Primary Meta Tags -->
                <meta name="title" content="MTN Mobile Money Invoice - Easy Payment Solution">
                <meta name="description" content="Automate your MTN Mobile Money payments with this easy-to-use invoice system. Created by ivainqueur to simplify mobile money transactions.">
                <meta name="author" content="ivainqueur">
                
                <!-- Open Graph / Facebook -->
                <meta property="og:type" content="website">
                <meta property="og:url" content="${req.protocol}://${req.get('host')}${req.originalUrl}">
                <meta property="og:title" content="MTN Mobile Money Invoice - Easy Payment Solution">
                <meta property="og:description" content="Automate your MTN Mobile Money payments with this easy-to-use invoice system. Created by ivainqueur to simplify mobile money transactions.">
                <meta property="og:image" content="https://placehold.co/600x400/FFCC1D/0E5475?text=MoMo+Invoice&font=montserrat">
                <meta property="og:site_name" content="MTN Mobile Money Invoice">
                
                <!-- Twitter -->
                <meta property="twitter:card" content="summary_large_image">
                <meta property="twitter:url" content="${req.protocol}://${req.get('host')}${req.originalUrl}">
                <meta property="twitter:title" content="MTN Mobile Money Invoice - Easy Payment Solution">
                <meta property="twitter:description" content="Automate your MTN Mobile Money payments with this easy-to-use invoice system. Created by ivainqueur to simplify mobile money transactions.">
                <meta property="twitter:image" content="https://placehold.co/600x400/FFCC1D/0E5475?text=MoMo+Invoice&font=montserrat">
                <meta property="twitter:creator" content="@ivainqueur">
                
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        background-color: #f5f5f5;
                    }
                    .message {
                        text-align: center;
                        padding: 2rem;
                        background: white;
                        border-radius: 8px;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    h1 { color: #333; }
                    p { color: #666; }
                </style>
            </head>
            <body>
                <div class="message">
                    <h1>Mobile Browser Required</h1>
                    <p>Please open this link using a mobile browser to proceed with the payment.</p>
                </div>
            </body>
        </html>
    `;
}

app.get('/', async (req, res) => {
    const { id, amount } = req.query
    
    if(!id || !amount) return res.status(400).send("Missing required parameters")

    if (!isMobileBrowser(req.headers['user-agent'])) {
        return res.send(getMobileBrowserRequiredHtml(req));
    }

    const isMerchant = Boolean(id.length < 10)
    res.redirect(`tel:*182*${isMerchant ? '8' : '1'}*1*${id}*${amount}#`)
})

app.get('/:id/:amount', async (req, res) => {
    const { id, amount } = req.params
    
    if(!id || !amount) return res.status(400).send("Missing required parameters")

    if (!isMobileBrowser(req.headers['user-agent'])) {
        return res.send(getMobileBrowserRequiredHtml(req));
    }

    const isMerchant = Boolean(id.length < 10)
    res.redirect(`tel:*182*${isMerchant ? '8' : '1'}*1*${id}*${amount}#`)
})

module.exports = app