import { createApp, watchEffect } from 'vue'
import App from './App.vue'
import { lang, initialLang, readLang } from './i18n'
import './style.css'
lang.value = initialLang(readLang(), navigator.language)
watchEffect(() => { document.documentElement.lang = lang.value })
createApp(App).mount('#app')
