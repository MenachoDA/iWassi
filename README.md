### Pasos de Ejecucion
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
