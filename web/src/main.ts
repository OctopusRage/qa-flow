import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './styles.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/Dashboard.vue') },
    { path: '/runs/new', component: () => import('./views/NewRun.vue') },
    { path: '/runs/:id', component: () => import('./views/RunDetail.vue'), props: true },
    { path: '/templates', component: () => import('./views/Templates.vue') },
    { path: '/templates/:id', component: () => import('./views/TemplateEdit.vue'), props: true },
    { path: '/settings', component: () => import('./views/Settings.vue') },
  ],
});

createApp(App).use(router).mount('#app');
