const NO_CORS_PATH = /^\/manie\/+(?:submissions|admin)(?:\/|$)/i

function corsExceptManie(corsMiddleware) {
    return function manieAwareCors(req, res, next) {
        if (NO_CORS_PATH.test(req.path)) return next()
        return corsMiddleware(req, res, next)
    }
}

function mountManie(app, corsMiddleware, router) {
    app.use(corsExceptManie(corsMiddleware))
    app.use('/manie', router || require('../../routes/manie').router)
}

module.exports = { mountManie, corsExceptManie, NO_CORS_PATH }
