import { createApp, watchEffect } from 'vue'
import App from './App.vue'
import { lang, initialLang, readLang } from './i18n'
import { setFilm } from './film'
import './style.css'
lang.value = initialLang(readLang(), navigator.language)
watchEffect(() => { document.documentElement.lang = lang.value })
setFilm(new URLSearchParams(location.search).get('film') === '1')
createApp(App).mount('#app')
