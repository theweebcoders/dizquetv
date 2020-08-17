FROM node:12.18-alpine3.12
WORKDIR /home/node/app
COPY package*.json ./
RUN npm install && npm install -g browserify nexe@3.3.7
COPY . .
RUN npm run build && LINUXBUILD=dizquetv sh make_dist.sh linuxonly

FROM jrottenberg/ffmpeg:4.2-ubuntu1804
EXPOSE 8000
WORKDIR /home/node/app
ENTRYPOINT [ "./dizquetv" ]
COPY --from=0 /home/node/app/dist/dizquetv /home/node/app/
RUN ln -s /usr/local/bin/ffmpeg /usr/bin/ffmpeg
