import { h } from 'vue'
import Teek from 'vitepress-theme-teek'
import 'vitepress-theme-teek/index.css'
import MermaidZoom from './MermaidZoom.vue'
import './custom.css'

export default {
  extends: Teek,
  Layout() {
    return h(Teek.Layout, null, {
      'layout-bottom': () => h(MermaidZoom)
    })
  }
}
