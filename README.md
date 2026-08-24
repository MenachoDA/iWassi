### Requisitos previos
**- Node.js (v18 o superior) y npm**

**- Cloudflare**

**- pm2 (Para la instalación en Windows)**

### Pasos de Ejecucion en macOS
1. **Ejecutar el Frontend**
   ```bash
   cd frontend
   npm install
   npm run build
   cd ..
2. **Encender el servidor**
   ```bash
   cd backend
   npm install
   cp .env.example .env
   npm run start
3. **Conseguir enlace publico en cloudflared**
   ```bash
   cloudflared tunnel --url http://localhost:3000
### Pasos de Ejecucion en Windows

1. **Ejecutar el Frontend**
   ```bash
   cd frontend
   npm install
   npm run build
   cd ..
   
2. **Encender el servidor**
   ```bash
   cd backend
   npm install
   copy .env.example .env
   pm2 start server.js --name "whatsapp-backend"
   
3. **Conseguir enlace publico en cloudflared**
   ```bash
   cloudflared tunnel --url http://localhost:3000
