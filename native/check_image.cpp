#include <SDL3/SDL.h>
#include <SDL3_image/SDL_image.h>
#include <iostream>
int main(int argc,char**argv){if(argc<2)return 2;if(!SDL_Init(SDL_INIT_VIDEO)){std::cerr<<SDL_GetError();return 1;}SDL_Window*w=SDL_CreateWindow("check",10,10,0);SDL_Renderer*r=SDL_CreateRenderer(w,nullptr);SDL_Texture*t=IMG_LoadTexture(r,argv[1]);std::cout<<(t?"OK":"FAIL")<<" path="<<argv[1]<<" error="<<SDL_GetError()<<"\n";if(t)SDL_DestroyTexture(t);SDL_DestroyRenderer(r);SDL_DestroyWindow(w);SDL_Quit();return t?0:1;}
